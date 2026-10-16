# Workspace avatars

Use a workspace's menu → **Change avatar** to choose a shape and a single body
color. The avatar belongs to the workspace ID, so renaming the folder or
switching Agent providers keeps the same face.

The UI reads and writes the host computer's
`~/.stillon/data/customizations/appearance/avatars.json`. Custom data directories
use the same `customizations/appearance/avatars.json` path below their data root.
This file contains the shape library, color palette and workspace choices. It
is created only when missing, preserved across upgrades, and shared with remote
Connect clients. There is no browser-only copy to keep in sync.

To customize it, edit the JSON and choose **Reload from file** in the avatar
dialog, or return focus to StillOn. Shape IDs are stable lowercase names;
`body` and `eyes` are SVG path data in a 64×64 view box. Each body has one fill,
and the eye marks are white. `eyeWidth` controls their stroke width. Palette
and choice colors use six-digit hex values. Add definitions to `shapes`, hex
colors to `palette`, and ID-to-choice mappings to `workspaces`.

The file accepts vector data, without executable SVG markup or external image
URLs. Invalid edits leave the last good appearance visible and must be fixed
before saving from the dialog. Safe mode renders built-in avatar definitions.
