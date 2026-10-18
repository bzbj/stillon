# File path renderer inventory

Source of truth: `src/shared/file-renderers.ts` and the text allowlists in
`src/shared/project-file-urls.ts`. This inventory describes file path links;
existing attachment-specific renderers remain separate and unchanged.

| Type | Renderer | MIME/behavior |
| --- | --- | --- |
| .html, .htm | Isolated HTML DOM | text/html; never executed on the app origin |
| .md, .markdown, .mdown | Shared Markdown | Original text, formatting and relative resources |
| .png, .jpg, .jpeg, .webp, .gif, .svg, .avif, .apng, .bmp, .ico | AttachmentImage/native img | Explicit image MIME; SVG stays an image |
| Listed text/code types below | Escaped text | Tags/scripts do not execute |
| Other paths, including DOCX/PPTX/PDF/PSD/RAW | No new path renderer | Local default app; authenticated remote original-byte download |

A directory keeps local Open/Show and does not acquire Preview or remote Download.
A decoded/authorized resource description determines its final capabilities;
preparing an opaque URL does not determine menu visibility.

## Text/code extensions

`.c`, `.cc`, `.cfg`, `.conf`, `.cpp`, `.cs`, `.css`, `.diff`, `.env`, `.go`, `.graphql`, `.h`, `.hpp`, `.ini`, `.java`, `.js`, `.json`, `.jsonc`, `.jsx`, `.kt`, `.log`, `.lua`, `.mjs`, `.patch`, `.php`, `.pl`, `.properties`, `.py`, `.rb`, `.rs`, `.scss`, `.sh`, `.sql`, `.swift`, `.toml`, `.ts`, `.tsx`, `.txt`, `.vue`, `.xml`, `.yaml`, `.yml`, `.zsh`.

## Text/code filenames

`.gitignore`, `.npmrc`, `.prettierrc`, `Dockerfile`, `Makefile`, `Gemfile`, `Procfile`.
