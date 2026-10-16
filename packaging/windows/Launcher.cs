using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Launcher {
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
      var start = new ProcessStartInfo(Path.Combine(payload, "runtime", "bun.exe")) {
        Arguments = "--no-env-file \"" + Path.Combine(payload, "bin", "desktop") + "\"" + (uninstall ? " --uninstall" : migration ? " --migrate" : upgrade ? " --update" : ""),
        WorkingDirectory = payload, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardError = true, RedirectStandardOutput = true
      };
      using (var form = new Form { Text = "StillOn", Width = 360, Height = 120, StartPosition = FormStartPosition.CenterScreen, ControlBox = false }) {
        form.Controls.Add(new Label { Text = uninstall ? "Removing background services…" : "Starting StillOn…", AutoSize = true, Left = 24, Top = 28 });
        form.Shown += async (sender, e) => {
          using (var process = Process.Start(start)) {
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            await Task.Run(() => process.WaitForExit());
            if (process.ExitCode != 0) { MessageBox.Show(await stdout + "\n" + await stderr, "StillOn needs attention", MessageBoxButtons.OK, MessageBoxIcon.Error); Environment.ExitCode = 1; }
          }
          form.Close();
        };
        Application.Run(form);
      }
      return Environment.ExitCode;
    } catch (Exception error) { MessageBox.Show(error.Message, "StillOn needs attention"); return 1; }
  }
}
