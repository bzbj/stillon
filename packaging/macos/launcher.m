#import <Cocoa/Cocoa.h>

static NSDictionary *readJSON(NSString *file) {
  NSData *data = [NSData dataWithContentsOfFile:file];
  return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}

static BOOL newerVersion(NSString *target, NSString *current) {
  if (!target || !current) return NO;
  NSArray *a = [target componentsSeparatedByString:@"."];
  NSArray *b = [current componentsSeparatedByString:@"."];
  for (NSUInteger i = 0; i < MAX(a.count, b.count); i++) {
    NSInteger x = i < a.count ? [a[i] integerValue] : 0;
    NSInteger y = i < b.count ? [b[i] integerValue] : 0;
    if (x != y) return x > y;
  }
  return NO;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *bundle = [[NSBundle mainBundle] resourcePath];
    NSString *runtime = [bundle stringByAppendingPathComponent:@"payload"];
    BOOL uninstall = argc > 1 && strcmp(argv[1], "--uninstall") == 0;
    if ([NSEvent modifierFlags] & NSEventModifierFlagOption) {
      NSAlert *actions = [[NSAlert alloc] init]; actions.messageText = @"StillOn";
      actions.informativeText = @"Open your workspace, or remove the background services before uninstalling the app.";
      [actions addButtonWithTitle:@"Open workspace"]; [actions addButtonWithTitle:@"Remove background services"]; [actions addButtonWithTitle:@"Cancel"];
      NSModalResponse choice = [actions runModal];
      if (choice == NSAlertThirdButtonReturn) return 0;
      uninstall = choice == NSAlertSecondButtonReturn;
    }
    NSString *marker = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/StillOn/ManagedUpdates/desktop.json"];
    NSString *root = [marker stringByDeletingLastPathComponent];
    BOOL installed = [[NSFileManager defaultManager] fileExistsAtPath:marker];
    BOOL migration = !installed && [[NSFileManager defaultManager] fileExistsAtPath:[root stringByAppendingPathComponent:@"deployment.json"]];
    NSString *active = readJSON([root stringByAppendingPathComponent:@"control.json"])[@"runtime"];
    BOOL upgrade = installed && newerVersion(readJSON([runtime stringByAppendingPathComponent:@"package.json"])[@"version"], active ? readJSON([active stringByAppendingPathComponent:@"package.json"])[@"version"] : nil);
    if (uninstall || migration || upgrade || !installed) {
      NSAlert *prompt = [[NSAlert alloc] init];
      prompt.messageText = uninstall ? @"Remove StillOn background services?" : migration ? @"Migrate to the installer version?" : upgrade ? @"Upgrade StillOn?" : @"Set up StillOn on this Mac?";
      prompt.informativeText = uninstall
        ? @"Your chats, settings, themes and skins will be kept. You can then remove StillOn from Applications."
        : migration
          ? @"Your chats, settings, themes and connection settings will be kept. Source code changes stay in the previous runtime and are not applied to the installer version. Finish active agent tasks and close embedded terminals first. Future updates download prebuilt programs."
          : upgrade
          ? @"Install the newer version from this app. Your data is backed up before switching; the previous version is restored if the update fails. Finish active agent tasks and close embedded terminals first."
          : @"StillOn runs in the background and starts when you sign in. Your workspace opens in your browser. Codex or Claude Code must already be installed and signed in.";
      [prompt addButtonWithTitle:uninstall ? @"Remove services" : migration ? @"Migrate and open" : upgrade ? @"Upgrade and open" : @"Set up and open"];
      [prompt addButtonWithTitle:@"Cancel"];
      [NSApp activateIgnoringOtherApps:YES];
      if ([prompt runModal] != NSAlertFirstButtonReturn) return 0;
    }
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 360, 100)
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"StillOn";
    NSTextField *label = [NSTextField labelWithString:uninstall ? @"Removing background services…" : @"Starting StillOn…"];
    label.frame = NSMakeRect(24, 40, 312, 24);
    [window.contentView addSubview:label];
    [window center]; [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSTask *task = [[NSTask alloc] init];
      task.executableURL = [NSURL fileURLWithPath:[runtime stringByAppendingPathComponent:@"runtime/bun"]];
      NSMutableArray *args = [NSMutableArray arrayWithObjects:@"--no-env-file", [runtime stringByAppendingPathComponent:@"bin/desktop"], nil];
      if (uninstall) [args addObject:@"--uninstall"];
      else if (migration) [args addObject:@"--migrate"];
      else if (upgrade) [args addObject:@"--update"];
      task.arguments = args;
      task.currentDirectoryURL = [NSURL fileURLWithPath:runtime];
      NSPipe *pipe = [NSPipe pipe]; task.standardOutput = pipe; task.standardError = pipe;
      NSError *error = nil;
      BOOL launched = [task launchAndReturnError:&error];
      NSData *data = launched ? [pipe.fileHandleForReading readDataToEndOfFile] : nil;
      if (launched) [task waitUntilExit];
      NSString *message = launched ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : error.localizedDescription;
      BOOL failed = !launched || task.terminationStatus != 0;
      dispatch_async(dispatch_get_main_queue(), ^{
        [window orderOut:nil];
        if (failed) {
          NSAlert *alert = [[NSAlert alloc] init]; alert.messageText = @"StillOn needs attention";
          alert.informativeText = message ?: @"Could not start StillOn. Your data has been kept.";
          [alert runModal];
        }
        [NSApp terminate:nil];
      });
    });
    [NSApp run];
  }
  return 0;
}
