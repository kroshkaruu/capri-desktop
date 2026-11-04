using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using Avalonia.Threading;

namespace CapriDesktop
{
    internal sealed partial class Settings
    {
        // The Russian build: voice chat with the wake word "Капри" on by default, set up once on the first start.
        [DataMember] internal bool EarsOff;
        [DataMember] internal bool RussianReady;
    }

    // Капри по-русски: слух с именем «Капри», таймеры и напоминания, ответы только текстом и всё на русском.
    internal sealed partial class Pet
    {
        private readonly Ears ears = new Ears();
        private Reminders reminders;
        private double wakeUntil = -1;
        private bool captioning;
        private bool earsTold;
        private double nextReminderCheck;

        private static readonly Regex WakeWord = new Regex(@"(?<![\p{L}\p{N}])(?:(?:эй|хей|окей|ок|hey)[\s,]+)?(?:капри|каприй|капре|кэпри|кепри|копри|капри|capri|kapri|capry)(?![\p{L}\p{N}])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex WakeAtStart = new Regex(@"^\W*(?:(?:эй|хей)[\s,]+)?(?:каприз|капризы|капризик)(?![\p{L}])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        // Called once from her constructor, right after her settings load.
        private void StartRussian()
        {
            if (!Saved.RussianReady)
            {
                Saved.RussianReady = true;
                Saved.Language = "Russian";
                Saved.VoiceProvider = Speakers.Off;
                Saved.Silent = true;
                Saved.Bubble = 2;
            }
            if (string.IsNullOrEmpty(Saved.Language) || Saved.Language == "English") Saved.Language = "Russian";
            try { reminders = new Reminders(folder, DateTime.Now); }
            catch (Exception) { reminders = null; }
            if (reminders != null) Hands.Remind = reminders.Remind;
            Hands.Routine = delegate { return "Сохранённые сценарии пока не поддерживаются, но можешь просто сказать, что сделать."; };
            ears.Partial = HeardPartly;
            ears.Phrase = HeardPhrase;
            ears.Problem = EarsProblem;
            ears.Ready = EarsReady;
        }

        // Called when her window first opens.
        private void StartListening()
        {
            if (Program.Smoke != null || Saved.EarsOff || !Ears.Present) return;
            ears.Start();
        }

        internal bool Listening { get { return ears.On; } }

        // The wave button and "Слушать «Капри»" in her menu.
        internal void ToggleEars()
        {
            ComeBack();
            if (!Ears.Present)
            {
                Talk.Answer("(голос)", "Голосовой чат работает только на Mac. Пиши мне пока текстом.");
                return;
            }
            bool on = !ears.On;
            Saved.EarsOff = !on;
            Save();
            if (on) { earsTold = false; ears.Start(); Talk.Answer("(голос)", "Включаю слух..."); }
            else { ears.Stop(); wakeUntil = -1; Talk.Answer("(голос)", "Больше не слушаю. Включить снова — кнопка с волной или «Слушать «Капри»» в меню."); }
            if (earsItem != null) earsItem.IsChecked = on;
        }

        private Avalonia.Controls.MenuItem earsItem;

        private void EarsReady(bool onDevice)
        {
            if (earsTold) return;
            earsTold = true;
            if (!Talk.Quiet && Talk.Reply != null && Talk.Reply.StartsWith("Включаю", StringComparison.Ordinal) == false) return;
            Talk.Answer("(голос)", onDevice
                ? "Слышу тебя. Скажи «Капри» — и что сделать или о чём спросить."
                : "Слышу тебя. Скажи «Капри» — и что сделать. Совет: включи Диктовку с русским языком в настройках клавиатуры, тогда я буду распознавать речь прямо на Mac, быстрее и без интернета.");
        }

        private void EarsProblem(string code, string text)
        {
            if (earsItem != null) earsItem.IsChecked = ears.On;
            ComeBack();
            Talk.Answer("(голос)", string.IsNullOrWhiteSpace(text) ? "С микрофоном что-то не так." : text);
            if (code == "mic_denied") OpenPrivacy("Privacy_Microphone");
            else if (code == "speech_denied") OpenPrivacy("Privacy_SpeechRecognition");
        }

        private static void OpenPrivacy(string pane)
        {
            try { Process.Start(new ProcessStartInfo("open", "x-apple.systempreferences:com.apple.preference.security?" + pane) { UseShellExecute = false }); }
            catch (Exception) { }
        }

        // Finds "Капри" in what she heard. command is the rest, without her name and the punctuation around it.
        internal static bool Woke(string heard, out string command)
        {
            command = null;
            string text = (heard ?? "").Replace('ё', 'е').Replace('Ё', 'Е');
            Match match = WakeWord.Match(text);
            if (!match.Success) match = WakeAtStart.Match(text);
            if (!match.Success) return false;
            string rest = text.Remove(match.Index, match.Length);
            command = Tidy(rest);
            return true;
        }

        private static string Tidy(string text)
        {
            string rest = Regex.Replace(text ?? "", @"\s+", " ");
            rest = Regex.Replace(rest, @"^[\s,.;:!?…—–-]+|[\s,;:—–-]+$", "");
            rest = Regex.Replace(rest, @"^(?:пожалуйста|слушай|послушай)[\s,]+", "", RegexOptions.IgnoreCase);
            rest = rest.Trim();
            if (rest.Length > 0) rest = char.ToUpper(rest[0], CultureInfo.GetCultureInfo("ru-RU")) + rest.Substring(1);
            if (Regex.IsMatch(rest, @"^[.!?…]+$")) rest = "";
            return rest;
        }

        private void HeardPartly(string text)
        {
            if (quitting) return;
            string command;
            bool woke = Woke(text, out command);
            if (!woke && Now > wakeUntil) return;
            if (!woke) command = Tidy(text);
            if (away) ComeBack();
            captioning = true;
            Talk.Thinking(command.Length == 0 ? "Капри…" : command + "…");
        }

        private void HeardPhrase(string text)
        {
            if (quitting) return;
            string command;
            bool woke = Woke(text, out command);
            bool listening = Now <= wakeUntil;
            if (!woke && !listening)
            {
                if (captioning) { captioning = false; Talk.Dismiss(); }
                return;
            }
            captioning = false;
            if (!woke) command = Tidy(text);
            if (away) ComeBack();
            if (clip == sleep) Wake();
            if (command.Length == 0)
            {
                // Just her name: she perks up and listens to the next thing they say.
                wakeUntil = Now + 8;
                Play(seat != null ? perchGlitch : glitch);
                Talk.Answer("Капри", "Да? Слушаю.");
                return;
            }
            wakeUntil = -1;
            Hear(command);
        }

        // Timers and reminders in plain Russian, done right away without asking her brain.
        private bool QuickRussian(string text, out string answer)
        {
            answer = null;
            if (reminders == null) return false;
            string plain = (text ?? "").ToLowerInvariant().Replace('ё', 'е').Trim().TrimEnd('.', '!', '?');
            Match timer = Regex.Match(plain, @"^(?:(?:поставь|поставить|заведи|завести|засеки|засечь|включи|запусти|сделай|установи)\s+)?(?:мне\s+)?таймер\s+(?:на\s+)?(.+)$");
            if (timer.Success)
            {
                ToolArguments args = new ToolArguments { Text = "Таймер", When = timer.Groups[1].Value };
                DateTime when;
                if (!Reminders.Parse(args.When, DateTime.Now, out when)) return false;
                answer = reminders.Remind(args);
                return true;
            }
            Match remind = Regex.Match(plain, @"^напомни(?:те)?\s+(?:мне\s+)?(через\s+.+?|в\s+\d{1,2}(?:[:.]\d{2})?(?:\s+(?:утра|дня|вечера|ночи))?|завтра\s+в\s+\d{1,2}(?:[:.]\d{2})?)\s*,?\s*(?:что\s+|о\s+том,?\s+что\s+|про\s+|об?\s+)?(.+)$");
            if (remind.Success)
            {
                string what = remind.Groups[2].Value.Trim();
                if (what.Length == 0) return false;
                ToolArguments args = new ToolArguments { Text = char.ToUpper(what[0]) + what.Substring(1), When = remind.Groups[1].Value };
                DateTime when;
                if (!Reminders.Parse(args.When, DateTime.Now, out when)) return false;
                answer = reminders.Remind(args);
                return true;
            }
            if (Regex.IsMatch(plain, @"^(?:какие|покажи|список)\s+(?:у меня\s+)?(?:мои\s+)?(?:таймеры|напоминания|таймеров|напоминаний)"))
            {
                answer = reminders.Remind(new ToolArguments { Action = "list" });
                return true;
            }
            Match cancel = Regex.Match(plain, @"^(?:отмени|убери|удали|выключи|сбрось|останови)\s+(?:мой\s+|моё\s+|мое\s+)?(таймер|напоминание)(?:\s+(?:про|о|об)?\s*(.+))?$");
            if (cancel.Success)
            {
                string what = cancel.Groups[2].Success && cancel.Groups[2].Value.Trim().Length > 0 ? cancel.Groups[2].Value.Trim() : cancel.Groups[1].Value == "таймер" ? "Таймер" : "";
                if (what.Length == 0) return false;
                answer = reminders.Remind(new ToolArguments { Action = "cancel", Text = what });
                return true;
            }
            return false;
        }

        // Every second: a timer or reminder that's due rings, pops her in and shows in her bubble and as a Mac notification.
        private void CheckReminders(double now)
        {
            if (reminders == null || now < nextReminderCheck) return;
            nextReminderCheck = now + 1;
            if (quitting || dragging) return;
            string line;
            try { line = reminders.Take(DateTime.Now); }
            catch (Exception) { return; }
            if (line == null) return;
            ComeBack();
            if (clip == sleep) Wake();
            ++asking;
            Play(seat != null ? perchGlitch : glitch);
            Talk.Answer("(таймер)", line);
            Ring(line);
        }

        private static void Ring(string line)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string safe = line.Replace("\\", "\\\\").Replace("\"", "\\\"");
                    using (Process note = Process.Start(new ProcessStartInfo("osascript", new[] { "-e", "display notification \"" + safe + "\" with title \"Капри\" sound name \"Glass\"" }) { UseShellExecute = false })) { }
                    for (int i = 0; i < 3; i++)
                        using (Process sound = Process.Start(new ProcessStartInfo("afplay", "/System/Library/Sounds/Glass.aiff") { UseShellExecute = false })) { if (sound != null) sound.WaitForExit(3000); }
                }
                catch (Exception) { }
            });
        }

        // A reply with no Russian in it, from one of her English tool lines: her brain puts it into Russian first.
        private static bool NeedsRussian(string said)
        {
            if (string.IsNullOrWhiteSpace(said) || Regex.IsMatch(said, @"[А-Яа-яЁё]")) return false;
            return Regex.Matches(said, @"\b[A-Za-z]{2,}\b").Count >= 2;
        }

        private bool Russify(int ticket, string heard, string said, string after, bool following)
        {
            if (Brain.Model == null || Brain.Language != "Russian" || !NeedsRussian(said)) return false;
            string english = said;
            ThreadPool.QueueUserWorkItem(delegate
            {
                string russian = null;
                try
                {
                    russian = Brain.Aside("You translate short messages from a cheeky cyberpunk desktop companion girl named Capri into natural, casual Russian. Use feminine forms for her (открыла, сделала). Keep app names, song titles, file names, numbers and times exactly as they are. Reply with the translation only.", english, 300);
                }
                catch (Exception) { }
                if (string.IsNullOrWhiteSpace(russian)) russian = english;
                string done = russian.Trim();
                Dispatcher.UIThread.Post(delegate
                {
                    if (ticket != asking) return;
                    Reply(ticket, heard, done, after, following, true);
                });
            });
            return true;
        }

        private static string RussianGreeting(int hour)
        {
            return hour >= 5 && hour < 12 ? "Доброе утро, чумба." : hour >= 22 || hour < 5 ? "Не поздновато ли, чумба?" : "Скучал по мне, чумба?";
        }
    }
}
