#import <Cocoa/Cocoa.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *bundle = [[NSBundle mainBundle] resourcePath];
    NSString *runtime = [bundle stringByAppendingPathComponent:@"payload"];
    BOOL uninstall = argc > 1 && strcmp(argv[1], "--uninstall") == 0;
    NSString *marker = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/StillOn/ManagedUpdates/desktop.json"];
    if (uninstall || ![[NSFileManager defaultManager] fileExistsAtPath:marker]) {
      NSAlert *prompt = [[NSAlert alloc] init];
      prompt.messageText = uninstall ? @"Remove StillOn background services?" : @"Set up StillOn on this Mac?";
      prompt.informativeText = uninstall
        ? @"Your chats, settings, themes and skins will be kept. You can then remove StillOn from Applications."
        : @"StillOn runs in the background and starts when you sign in. Your workspace opens in your browser. Codex or Claude Code must already be installed and signed in.";
      [prompt addButtonWithTitle:uninstall ? @"Remove services" : @"Set up and open"];
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
