# Attachment upload recovery

Attachments of 4 MiB or larger use checksummed 1 MiB chunks when the host
advertises upload protocol 1. The original bytes and 100 MiB file limit are
preserved. Smaller files and older hosts use the existing single multipart POST.
The client checks support before sending any chunks, so an older host never
mistakes a chunk for a complete attachment.

The host stages chunks on the computer, outside the workspace upload directory.
Only a complete file becomes an attachment. Each accepted chunk returns a
confirmed byte offset. Replaying a chunk checks its SHA-256 and returns the same
offset; replaying a completed upload returns the existing attachment receipt.
This covers a connection dropping after the host saved data but before the
browser received its reply.

Network failures, temporary gateway responses (including the tunnel's HTML 404)
and a chunk making no progress for 60 seconds trigger up to three retries after
1, 3 and 8 seconds. There is no overall upload-duration limit. Authorization and
permission failures are not replayed. A legacy whole-file POST is not retried
automatically because its response could have been lost after saving the file.

After retries are exhausted, the composer keeps the original File and offers
**Retry failed uploads**. Confirmed chunks are skipped on continuation. The draft
and failed attachment remain visible, and sending waits for completion or removal.

Recovery is scoped to the workspace and authenticated owner. Staging and receipts
expire after 30 minutes without activity, and do not survive a host process
restart. The host bounds unfinished sessions to 16 and receipts to 256; older
completed receipts can be evicted. The original File is retained only in the
current composer session. Reloading or changing chats requires selecting it again.
This is connection recovery, not durable deduplication across host restarts.

`GET /api/projects/:id/uploads` advertises the protocol, chunk size and maximum
file size. Chunk POSTs carry `x-upload-protocol`, `x-upload-id`, `x-upload-offset`,
`x-upload-size` and `x-upload-sha256` with one multipart `files` field. These are
application headers; the reserved `X-StillOn-*` authentication namespace is not
used. Existing ingress and workspace authorization apply to both routes.

Run the client recovery and host storage regressions with:

```sh
bun test src/client/lib/attachmentUpload.test.ts src/server/chunked-uploads.test.ts
```

Managed gateway/native tunnel acceptance lives in the private Connect repository
and must run against the exact proposed public revision.
