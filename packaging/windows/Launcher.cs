using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Launcher {
  static readonly string LogFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StillOn", "launcher.log");
  static void Log(string message) {
    try {
      Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
      if (File.Exists(LogFile) && new FileInfo(LogFile).Length > 2 * 1024 * 1024) {
        File.Copy(LogFile, LogFile + ".previous", true);
        File.WriteAllText(LogFile, "");
      }
      File.AppendAllText(LogFile, "[" + DateTimeOffset.Now.ToString("O") + "] " + message + Environment.NewLine);
    } catch { /* A logging failure must not prevent startup or recovery. */ }
  }
  static async Task<string> ReadOutput(StreamReader reader, Label progress) {
    var output = new StringBuilder();
    string line;
    while ((line = await reader.ReadLineAsync()) != null) {
      if (output.Length < 64 * 1024) output.AppendLine(line.Substring(0, Math.Min(line.Length, 64 * 1024 - output.Length)));
      const string prefix = "STILLON_DESKTOP_PROGRESS: ";
      if (progress != null && line.StartsWith(prefix, StringComparison.Ordinal)) {
        progress.Text = line.Substring(prefix.Length);
        Log(progress.Text);
      }
    }
    return output.ToString();
  }
  static void Failure(string message) {
    Environment.ExitCode = 1;
    MessageBox.Show(message + "\n\nDetails: " + LogFile, "StillOn needs attention", MessageBoxButtons.OK, MessageBoxIcon.Error);
  }
  static Dictionary<string, object> ReadJson(string file) {
    try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); }
    catch { return new Dictionary<string, object>(); }
  }
  static string Value(Dictionary<string, object> data, string key) { return data.ContainsKey(key) ? data[key] as string : null; }
  static bool Newer(string target, string current) {
    Version a, b;
    return Version.TryParse(target, out a) && Version.TryParse(current, out b) && a > b;
  }
  [STAThread]
  static int Main(string[] args) {
    Application.EnableVisualStyles();
    string payload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload");
    bool uninstall = args.Length == 1 && args[0] == "--uninstall";
    string marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StillOn", "ManagedUpdates", "desktop.json");
    string root = Path.GetDirectoryName(marker);
    bool migration = !File.Exists(marker) && File.Exists(Path.Combine(root, "deployment.json"));
    string active = Value(ReadJson(Path.Combine(root, "control.json")), "runtime");
    bool upgrade = File.Exists(marker) && active != null && Newer(Value(ReadJson(Path.Combine(payload, "package.json")), "version"), Value(ReadJson(Path.Combine(active, "package.json")), "version"));
    if (!uninstall && (migration || upgrade || !File.Exists(marker))) {
      string prompt = migration
        ? "Migrate to the installer version? Chats, settings, themes and connection settings are kept. Source code changes remain in the previous runtime and are not applied to the installer version. Finish agent tasks and close embedded terminals first. Future updates download prebuilt programs."
        : upgrade
        ? "Install the newer StillOn version? Data is backed up before switching and the previous version is restored if the update fails. Finish agent tasks and close embedded terminals first."
        : "StillOn runs in the background and starts when you sign in. Your workspace opens in your browser. Codex or Claude Code must already be installed and signed in. Set up StillOn?";
      if (MessageBox.Show(prompt, "StillOn", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
    }
    try {
      Log("Starting desktop command: " + (uninstall ? "uninstall" : migration ? "migrate" : upgrade ? "update" : "open"));
      var start = new ProcessStartInfo(Path.Combine(payload, "runtime", "bun.exe")) {
        Arguments = "--no-env-file \"" + Path.Combine(payload, "bin", "desktop") + "\"" + (uninstall ? " --uninstall" : migration ? " --migrate" : upgrade ? " --update" : ""),
        WorkingDirectory = payload, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardError = true, RedirectStandardOutput = true
      };
      using (var form = new Form { Text = "StillOn", Width = 500, Height = 160, StartPosition = FormStartPosition.CenterScreen, ControlBox = false }) {
        var progress = new Label { Text = uninstall ? "Removing background services…" : "Starting StillOn…", Width = 440, Height = 80, Left = 24, Top = 28 };
        form.Controls.Add(progress);
        form.Shown += async (sender, e) => {
          try {
            using (var process = Process.Start(start)) {
              var stdout = ReadOutput(process.StandardOutput, progress); var stderr = ReadOutput(process.StandardError, null);
              await Task.Run(() => process.WaitForExit());
              string output = await stdout, errors = await stderr;
              Log("exit=" + process.ExitCode + "\nSTDOUT:\n" + output + "\nSTDERR:\n" + errors);
              if (process.ExitCode != 0) Failure(output + "\n" + errors);
            }
          } catch (Exception error) { Log(error.ToString()); Failure(error.Message); }
          finally { form.Close(); }
        };
        Application.Run(form);
      }
      return Environment.ExitCode;
    } catch (Exception error) { Log(error.ToString()); Failure(error.Message); return 1; }
  }
}
