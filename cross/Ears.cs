using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using Avalonia.Threading;

namespace CapriDesktop
{
    // Her ears on a Mac: the CapriEars helper next to her in the app listens with Apple's speech recognition and prints what it
    // hears, one JSON line at a time. This starts it, reads it and hands the words to her on the UI thread.
    internal sealed class Ears
    {
        internal Action<string> Partial = delegate { };
        internal Action<string> Phrase = delegate { };
        internal Action<string, string> Problem = delegate { };
        internal Action<bool> Ready = delegate { };

        private readonly object gate = new object();
        private Process helper;
        private bool wanted;
        private int crashes;
        private int run;

        internal bool On { get { lock (gate) return wanted; } }

        internal static string HelperPath
        {
            get { return Path.Combine(AppContext.BaseDirectory, "CapriEars"); }
        }

        internal static bool Present { get { return OperatingSystem.IsMacOS() && File.Exists(HelperPath); } }

        internal void Start()
        {
            lock (gate)
            {
                wanted = true;
                crashes = 0;
                if (helper != null) return;
            }
            Launch();
        }

        internal void Stop()
        {
            Process old;
            lock (gate)
            {
                wanted = false;
                run++;
                old = helper;
                helper = null;
            }
            Kill(old);
        }

        private void Launch()
        {
            if (!Present) { Post(() => Problem("missing", "Не нашла свой модуль слуха (CapriEars). Переустанови Капри.")); return; }
            ProcessStartInfo info = new ProcessStartInfo(HelperPath)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            info.ArgumentList.Add("ru-RU");
            info.ArgumentList.Add("1.1");
            info.ArgumentList.Add("Капри|Капри,|Капри открой|Капри поставь таймер");
            Process started;
            int mine;
            try { started = Process.Start(info); }
            catch (Exception error) { Post(() => Problem("start", "Не получилось включить слух: " + error.Message)); return; }
            if (started == null) return;
            lock (gate)
            {
                if (!wanted) { Kill(started); return; }
                helper = started;
                mine = ++run;
            }
            Thread reader = new Thread(() => Read(started, mine)) { IsBackground = true, Name = "Capri ears" };
            reader.Start();
            Thread errors = new Thread(() => { try { while (started.StandardError.ReadLine() != null) { } } catch (Exception) { } }) { IsBackground = true };
            errors.Start();
        }

        private void Read(Process source, int mine)
        {
            string code = null;
            try
            {
                string line;
                while ((line = source.StandardOutput.ReadLine()) != null)
                {
                    string type, text = null;
                    bool onDevice = false;
                    try
                    {
                        using (JsonDocument json = JsonDocument.Parse(line))
                        {
                            JsonElement root = json.RootElement;
                            type = root.GetProperty("type").GetString();
                            JsonElement value;
                            if (root.TryGetProperty("text", out value)) text = value.GetString();
                            if (root.TryGetProperty("code", out value)) code = value.GetString();
                            if (root.TryGetProperty("onDevice", out value)) onDevice = value.ValueKind == JsonValueKind.True;
                        }
                    }
                    catch (Exception) { continue; }
                    if (!Current(mine)) return;
                    string said = text ?? "";
                    if (type == "partial") Post(() => { if (Current(mine)) Partial(said); });
                    else if (type == "phrase") Post(() => { if (Current(mine)) Phrase(said); });
                    else if (type == "ready") { bool local = onDevice; Post(() => { if (Current(mine)) { crashes = 0; Ready(local); } }); }
                    else if (type == "error") { string which = code; Post(() => { if (Current(mine)) Problem(which, said); }); }
                }
            }
            catch (Exception) { }
            // It stopped. Permission problems stay stopped; anything else starts again a few times.
            bool again;
            lock (gate)
            {
                if (mine != run || !wanted) return;
                helper = null;
                again = code != "mic_denied" && code != "speech_denied" && code != "no_language" && code != "no_mic" && ++crashes <= 5;
                if (!again) wanted = false;
            }
            int wait = 2 * crashes;
            if (again) Post(() => DispatcherTimer.RunOnce(() => { lock (gate) { if (!wanted || helper != null) return; } Launch(); }, TimeSpan.FromSeconds(wait)));
            else if (code == null) Post(() => Problem("stopped", "Мой слух отключился. Включи его снова кнопкой с волной."));
        }

        private bool Current(int mine) { lock (gate) return mine == run && wanted; }

        private static void Post(Action action) { Dispatcher.UIThread.Post(action); }

        private static void Kill(Process process)
        {
            if (process == null) return;
            try { process.StandardInput.Close(); } catch (Exception) { }
            try { if (!process.WaitForExit(300)) process.Kill(); } catch (Exception) { }
            try { process.Dispose(); } catch (Exception) { }
        }
    }
}
