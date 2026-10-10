#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppArch
  #error AppArch is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{85A34765-6311-41BB-A86D-5AB8FB4FA0A1}
AppName=StillOn
AppVersion={#AppVersion}
AppPublisher=StillOn
AppPublisherURL=https://github.com/bzbj/stillon
DefaultDirName={localappdata}\Programs\StillOn
DefaultGroupName=StillOn
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
#if AppArch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
#endif
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=StillOn-{#AppVersion}-windows-{#AppArch}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\StillOn.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\StillOn"; Filename: "{app}\StillOn.exe"
Name: "{autodesktop}\StillOn"; Filename: "{app}\StillOn.exe"; Tasks: desktopicon

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\StillOn.exe"; Description: "Set up and open StillOn (runs in the background)"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{app}\payload\runtime\bun.exe'), '--no-env-file "' + ExpandConstant('{app}\payload\bin\desktop') + '" --uninstall', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    MsgBox('StillOn could not stop safely. Finish active tasks or update recovery, then retry uninstalling. Your data has been kept.', mbError, MB_OK);
end;
