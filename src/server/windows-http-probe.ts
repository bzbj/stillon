import { execFile } from "node:child_process"

// Windows Bun cannot reliably honor HTTP socket overrides and can crash on a
// refused raw IPv6 dial. Batch metadata probes through the system HTTP client.
// No PowerShell profile, configured egress proxy, credentials or service changes.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Net.Http,System.Core -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
public class StillOnHttpMetadata {
  public int port; public int status; public string html;
}
public static class StillOnHttpDiscovery {
  static async Task<StillOnHttpMetadata> Probe(HttpClient client, int port, string host, CancellationToken token) {
    try {
      var logical = new Uri("http://localhost:" + port + "/");
      for (int redirect = 0; redirect <= 3; redirect++) {
        var physical = new UriBuilder(logical); physical.Host = host;
        using (var request = new HttpRequestMessage(HttpMethod.Get, physical.Uri)) {
          request.Headers.Host = logical.Authority;
          request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
          request.Headers.ConnectionClose = true;
          using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token)) {
            int status = (int)response.StatusCode;
            if (status >= 300 && status < 400 && response.Headers.Location != null && redirect < 3) {
              Uri next;
              if (!Uri.TryCreate(logical, response.Headers.Location, out next) || next.Scheme != "http" || next.Port != port
                || next.UserInfo.Length != 0 || !(next.Host == "localhost" || next.Host == "127.0.0.1" || next.Host == "[::1]" || next.Host == "::1")) return null;
              logical = next; continue;
            }
            if (status < 200 || status >= 400 || response.Content.Headers.ContentType == null
              || response.Content.Headers.ContentType.MediaType.ToLowerInvariant() != "text/html") return null;
            using (var dispose = token.Register(() => response.Dispose()))
            using (var stream = await response.Content.ReadAsStreamAsync()) {
              var buffer = new byte[65536]; int offset = 0;
              while (offset < buffer.Length) {
                int count = await stream.ReadAsync(buffer, offset, buffer.Length - offset, token);
                offset += count;
                var html = Encoding.UTF8.GetString(buffer, 0, offset);
                var title = Regex.Match(html, @"<title[^>]*>([\s\S]*?)</title\s*>", RegexOptions.IgnoreCase);
                if (title.Success) return new StillOnHttpMetadata { port = port, status = status,
                  html = "<title>" + title.Groups[1].Value.Substring(0, Math.Min(4096, title.Groups[1].Value.Length)) + "</title>" };
                if (count == 0) break;
              }
            }
            return null;
          }
        }
      }
    } catch { }
    return null;
  }
  static async Task<StillOnHttpMetadata> Port(HttpClient client, int port) {
    // Include actual service response time, but not PowerShell/JIT startup.
    using (var cancel = new CancellationTokenSource(1500)) {
      var pending = new List<Task<StillOnHttpMetadata>> { Probe(client, port, "127.0.0.1", cancel.Token), Probe(client, port, "::1", cancel.Token) };
      while (pending.Count != 0) {
        var done = await Task.WhenAny(pending); pending.Remove(done);
        var result = await done;
        if (result != null) { cancel.Cancel(); return result; }
      }
      return null;
    }
  }
  public static async Task<StillOnHttpMetadata[]> Scan(int[] ports) {
    using (var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false, UseCookies = false, MaxResponseHeadersLength = 16 })
    using (var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan }) {
      var pending = new List<Task<StillOnHttpMetadata>>();
      foreach (int port in ports) pending.Add(Port(client, port));
      return await Task.WhenAll(pending);
    }
  }
}
'@
[int[]]$ports = ConvertFrom-Json ([Console]::In.ReadToEnd())
$results = [StillOnHttpDiscovery]::Scan($ports).GetAwaiter().GetResult()
ConvertTo-Json -InputObject @($results | Where-Object { $null -ne $_ }) -Compress
`

export async function probeWindowsHttpPorts(ports: number[]) {
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid discovery port")
  if (!ports.length) return new Map<number, Response>()
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      // Cold PowerShell/.NET compilation can exceed ten seconds on a fresh
      // Windows host. Each actual HTTP probe still has its own 1.5s deadline.
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(JSON.stringify(ports))
  })
  const values = JSON.parse(output.trim() || "[]") as { port: number; status: number; html: string }[]
  return new Map(values.map(value => [value.port, new Response(value.html, { status: value.status, headers: { "Content-Type": "text/html" } })]))
}
