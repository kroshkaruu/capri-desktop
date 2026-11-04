using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Threading;
using Whisper.net;

namespace CapriDesktop
{
    // Её уши на Mac: микрофон через AudioQueue, простое определение речи по громкости и распознавание Whisper прямо на компьютере
    // (бесплатно, без интернета, по-русски). Каждая законченная фраза уходит в Phrase, начало речи — в Partial("…").
    internal sealed class Ears
    {
        internal Action<string> Partial = delegate { };
        internal Action<string> Phrase = delegate { };
        internal Action<string, string> Problem = delegate { };
        internal Action<bool> Ready = delegate { };
        internal Action<string> Status = delegate { };

        internal const string ModelName = "ggml-small-q5_1.bin";
        private const string ModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + ModelName;
        private const int Rate = 16000;

        private readonly object gate = new object();
        private bool wanted;
        private int run;
        private Mic mic;
        private Thread worker;
        private BlockingCollection<float[]> clips;

        internal bool On { get { lock (gate) return wanted; } }

        internal static bool Present { get { return OperatingSystem.IsMacOS(); } }

        internal static string AppSupport
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Capri"); }
        }

        internal static string ModelPath
        {
            get
            {
                string bundled = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Resources", ModelName));
                if (File.Exists(bundled)) return bundled;
                string beside = Path.Combine(AppContext.BaseDirectory, ModelName);
                if (File.Exists(beside)) return beside;
                return Path.Combine(AppSupport, ModelName);
            }
        }

        internal void Start()
        {
            int mine;
            lock (gate)
            {
                if (wanted) return;
                wanted = true;
                mine = ++run;
                clips = new BlockingCollection<float[]>(8);
            }
            BlockingCollection<float[]> queue = clips;
            worker = new Thread(() => Work(mine, queue)) { IsBackground = true, Name = "Capri ears" };
            worker.Start();
        }

        internal void Stop()
        {
            Mic old;
            BlockingCollection<float[]> queue;
            lock (gate)
            {
                wanted = false;
                run++;
                old = mic;
                mic = null;
                queue = clips;
                clips = null;
            }
            if (old != null) old.Dispose();
            if (queue != null) try { queue.CompleteAdding(); } catch (Exception) { }
        }

        private bool Current(int mine) { lock (gate) return wanted && mine == run; }

        private void Post(int mine, Action action) { Dispatcher.UIThread.Post(() => { if (Current(mine)) action(); }); }

        private void Work(int mine, BlockingCollection<float[]> queue)
        {
            try
            {
                string model = ModelPath;
                if (!File.Exists(model))
                {
                    Post(mine, () => Status("Скачиваю модуль распознавания речи (≈180 МБ), это один раз..."));
                    Download(model);
                }
                if (!Current(mine)) return;
                using (WhisperFactory factory = WhisperFactory.FromPath(model))
                using (WhisperProcessor processor = factory.CreateBuilder()
                    .WithLanguage("ru")
                    .WithPrompt("Капри, открой Телеграм. Капри, поставь таймер на 10 минут.")
                    .WithThreads(Math.Max(2, Math.Min(6, Environment.ProcessorCount - 2)))
                    .WithNoContext()
                    .WithSingleSegment()
                    .Build())
                {
                    int access = Mic.Access();
                    if (access == 1 || access == 2)
                    {
                        Post(mine, () => { Problem("mic_denied", "Нет доступа к микрофону. Разреши его Capri: Системные настройки → Конфиденциальность и безопасность → Микрофон. Потом включи слух снова."); });
                        lock (gate) { if (mine == run) wanted = false; }
                        return;
                    }
                    Mic opened = new Mic(clip => { try { queue.TryAdd(clip); } catch (Exception) { } }, () => Post(mine, () => Partial("…")));
                    string error = opened.Open();
                    if (error != null)
                    {
                        opened.Dispose();
                        Post(mine, () => Problem("mic_failed", error));
                        lock (gate) { if (mine == run) wanted = false; }
                        return;
                    }
                    lock (gate)
                    {
                        if (mine != run) { opened.Dispose(); return; }
                        mic = opened;
                    }
                    Post(mine, () => Ready(true));
                    foreach (float[] clip in queue.GetConsumingEnumerable())
                    {
                        if (!Current(mine)) break;
                        string text = Transcribe(processor, clip);
                        if (text.Length > 0) Post(mine, () => Phrase(text));
                    }
                }
            }
            catch (Exception error)
            {
                string why = error.Message;
                Post(mine, () => Problem("start", "Не получилось включить слух: " + why));
                lock (gate) { if (mine == run) wanted = false; }
            }
        }

        private static string Transcribe(WhisperProcessor processor, float[] clip)
        {
            List<string> parts = new List<string>();
            Task.Run(async () =>
            {
                await foreach (SegmentData segment in processor.ProcessAsync(clip)) parts.Add(segment.Text);
            }).GetAwaiter().GetResult();
            string text = Regex.Replace(string.Join(" ", parts), @"\s+", " ").Trim();
            text = Regex.Replace(text, @"^[\[\(].*?[\]\)]$", "");
            // Что Whisper «слышит» в тишине и шуме.
            if (Regex.IsMatch(text, @"^(?:продолжение следует|субтитры|редактор субтитров|спасибо за просмотр|подписывайтесь|ставьте лайки|музыка|аплодисменты|смех|\.+|…+)", RegexOptions.IgnoreCase)) return "";
            return text;
        }

        private static void Download(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string part = path + ".part";
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromMinutes(30) })
            using (Stream source = client.GetStreamAsync(ModelUrl).GetAwaiter().GetResult())
            using (FileStream target = File.Create(part)) source.CopyTo(target);
            File.Move(part, path, true);
        }

        // Микрофон: AudioQueue в 16 кГц моно, и поиск фраз по громкости.
        private sealed class Mic : IDisposable
        {
            private const string Toolbox = "/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox";
            private const int Frame = 480; // 30 мс

            [StructLayout(LayoutKind.Sequential)]
            private struct StreamFormat
            {
                public double SampleRate;
                public uint FormatId;
                public uint FormatFlags;
                public uint BytesPerPacket;
                public uint FramesPerPacket;
                public uint BytesPerFrame;
                public uint ChannelsPerFrame;
                public uint BitsPerChannel;
                public uint Reserved;
            }

            [StructLayout(LayoutKind.Sequential)]
            private struct QueueBuffer
            {
                public uint Capacity;
                public IntPtr Data;
                public uint Size;
                public IntPtr UserData;
                public uint DescriptionCapacity;
                public IntPtr Descriptions;
                public uint DescriptionCount;
            }

            [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
            private delegate void InputCallback(IntPtr user, IntPtr queue, IntPtr buffer, IntPtr startTime, uint count, IntPtr descriptions);

            [DllImport(Toolbox)] private static extern int AudioQueueNewInput(ref StreamFormat format, InputCallback callback, IntPtr user, IntPtr runLoop, IntPtr mode, uint flags, out IntPtr queue);
            [DllImport(Toolbox)] private static extern int AudioQueueAllocateBuffer(IntPtr queue, uint size, out IntPtr buffer);
            [DllImport(Toolbox)] private static extern int AudioQueueEnqueueBuffer(IntPtr queue, IntPtr buffer, uint count, IntPtr descriptions);
            [DllImport(Toolbox)] private static extern int AudioQueueStart(IntPtr queue, IntPtr startTime);
            [DllImport(Toolbox)] private static extern int AudioQueueStop(IntPtr queue, byte immediate);
            [DllImport(Toolbox)] private static extern int AudioQueueDispose(IntPtr queue, byte immediate);

            private readonly Action<float[]> heard;
            private readonly Action began;
            private readonly InputCallback callback;
            private IntPtr queue;
            private volatile bool running;
            private readonly object gate = new object();

            // Определение речи.
            private readonly List<float> pending = new List<float>();
            private readonly Queue<float[]> before = new Queue<float[]>();
            private readonly List<float> speech = new List<float>();
            private bool talking;
            private int loudFrames, quietFrames;
            private double floor = 0.004;

            internal Mic(Action<float[]> heard, Action began)
            {
                this.heard = heard;
                this.began = began;
                callback = Filled;
            }

            internal string Open()
            {
                StreamFormat format = new StreamFormat
                {
                    SampleRate = Rate,
                    FormatId = 0x6C70636D, // 'lpcm'
                    FormatFlags = 4 | 8, // signed integer, packed
                    BytesPerPacket = 2,
                    FramesPerPacket = 1,
                    BytesPerFrame = 2,
                    ChannelsPerFrame = 1,
                    BitsPerChannel = 16,
                };
                int status = AudioQueueNewInput(ref format, callback, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out queue);
                if (status != 0) return "Не получилось открыть микрофон (код " + status + ").";
                for (int i = 0; i < 4; i++)
                {
                    IntPtr buffer;
                    if (AudioQueueAllocateBuffer(queue, Rate / 10 * 2, out buffer) != 0) return "Не получилось подготовить микрофон.";
                    AudioQueueEnqueueBuffer(queue, buffer, 0, IntPtr.Zero);
                }
                running = true;
                status = AudioQueueStart(queue, IntPtr.Zero);
                if (status != 0) { running = false; return "Не получилось включить микрофон (код " + status + "). Проверь доступ: Системные настройки → Конфиденциальность и безопасность → Микрофон."; }
                return null;
            }

            private void Filled(IntPtr user, IntPtr aq, IntPtr buffer, IntPtr startTime, uint count, IntPtr descriptions)
            {
                try
                {
                    QueueBuffer data = Marshal.PtrToStructure<QueueBuffer>(buffer);
                    int samples = (int)data.Size / 2;
                    if (samples > 0)
                    {
                        short[] raw = new short[samples];
                        Marshal.Copy(data.Data, raw, 0, samples);
                        lock (gate) Take(raw);
                    }
                }
                catch (Exception) { }
                if (running) AudioQueueEnqueueBuffer(aq, buffer, 0, IntPtr.Zero);
            }

            private void Take(short[] raw)
            {
                foreach (short sample in raw) pending.Add(sample / 32768f);
                while (pending.Count >= Frame)
                {
                    float[] frame = pending.GetRange(0, Frame).ToArray();
                    pending.RemoveRange(0, Frame);
                    Step(frame);
                }
            }

            private void Step(float[] frame)
            {
                double sum = 0;
                foreach (float value in frame) sum += value * value;
                double level = Math.Sqrt(sum / frame.Length);
                double threshold = Math.Max(0.012, floor * 3.2);
                bool loud = level > threshold;
                if (!talking)
                {
                    // Шум комнаты подстраивается, пока никто не говорит.
                    floor = floor * 0.97 + Math.Min(level, 0.05) * 0.03;
                    before.Enqueue(frame);
                    while (before.Count > 12) before.Dequeue();
                    loudFrames = loud ? loudFrames + 1 : 0;
                    if (loudFrames >= 3)
                    {
                        talking = true;
                        quietFrames = 0;
                        speech.Clear();
                        foreach (float[] early in before) speech.AddRange(early);
                        before.Clear();
                        try { began(); } catch (Exception) { }
                    }
                    return;
                }
                speech.AddRange(frame);
                quietFrames = loud ? 0 : quietFrames + 1;
                bool ended = quietFrames >= 24; // ~0,7 с тишины
                bool tooLong = speech.Count >= Rate * 15;
                if (!ended && !tooLong) return;
                talking = false;
                loudFrames = 0;
                if (speech.Count >= Rate * 6 / 10)
                {
                    float[] clip = speech.ToArray();
                    // Тихий голос — громче, чтобы Whisper лучше разобрал.
                    float peak = 0;
                    foreach (float value in clip) peak = Math.Max(peak, Math.Abs(value));
                    if (peak > 0 && peak < 0.5f) { float gain = Math.Min(8f, 0.7f / peak); for (int i = 0; i < clip.Length; i++) clip[i] *= gain; }
                    try { heard(clip); } catch (Exception) { }
                }
                speech.Clear();
            }

            public void Dispose()
            {
                running = false;
                if (queue != IntPtr.Zero)
                {
                    try { AudioQueueStop(queue, 1); AudioQueueDispose(queue, 1); } catch (Exception) { }
                    queue = IntPtr.Zero;
                }
            }

            // Доступ к микрофону: 0 ещё не спрашивали, 1 запрещено системой, 2 запрещено, 3 разрешено, -1 неизвестно.
            [DllImport("/usr/lib/libobjc.A.dylib")] private static extern IntPtr objc_getClass(string name);
            [DllImport("/usr/lib/libobjc.A.dylib")] private static extern IntPtr sel_registerName(string name);
            [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")] private static extern IntPtr Send(IntPtr target, IntPtr selector, string argument);
            [DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")] private static extern long SendLong(IntPtr target, IntPtr selector, IntPtr argument);
            [DllImport("/usr/lib/libSystem.dylib")] private static extern IntPtr dlopen(string path, int mode);

            internal static int Access()
            {
                try
                {
                    dlopen("/System/Library/Frameworks/AVFoundation.framework/AVFoundation", 1);
                    IntPtr device = objc_getClass("AVCaptureDevice");
                    IntPtr strings = objc_getClass("NSString");
                    if (device == IntPtr.Zero || strings == IntPtr.Zero) return -1;
                    IntPtr audio = Send(strings, sel_registerName("stringWithUTF8String:"), "soun");
                    return (int)SendLong(device, sel_registerName("authorizationStatusForMediaType:"), audio);
                }
                catch (Exception) { return -1; }
            }
        }
    }
}
