using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Launcher {
  [STAThread]
  static int Main(string[] args) {
    Application.EnableVisualStyles();
    string payload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "payload");
    bool uninstall = args.Length == 1 && args[0] == "--uninstall";
    string marker = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StillOn", "ManagedUpdates", "desktop.json");
    if (!uninstall && !File.Exists(marker) && MessageBox.Show(
      "StillOn runs in the background and starts when you sign in. Your workspace opens in your browser. Codex or Claude Code must already be installed and signed in.\n\nSet up StillOn?",
      "StillOn", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
    try {
      var start = new ProcessStartInfo(Path.Combine(payload, "runtime", "bun.exe")) {
        Arguments = "--no-env-file \"" + Path.Combine(payload, "bin", "desktop") + "\"" + (uninstall ? " --uninstall" : ""),
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
