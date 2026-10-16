# Workspace previews

The browser panel keeps workspace preview addresses on the current StillOn
origin. A saved localhost address therefore opens the same workspace through
Connect, and Open external uses that same address in a new tab.

HTML documents remain in an opaque sandbox. Relative scripts (including ES
modules), styles, images and fonts load through a random, read-only resource
capability scoped to the HTML document's folder. Root-relative references into
that folder are rewritten too. Assets outside it, hidden files, traversal and
symlinks escaping it are denied. Put a standalone preview's assets beside its
HTML or in child folders.

The initial HTML request uses normal app authentication. Resource capabilities
expire after one hour; refresh the original preview URL to renew them. Local
logout clears them. Connect capabilities are bound to the computer and parent
session and stop working on logout, pause or unlink. They grant no app API or
general localhost proxy access. Both routes retain Host checks, filesystem
boundaries and a sandbox without `allow-same-origin`.
