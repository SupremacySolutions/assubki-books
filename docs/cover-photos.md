# Photographing a cover

The covers on this site are the merchandise. This is how to take one so it
comes out looking like the rest.

## Use a scanner app, not the camera

Not the camera app. A **document scanner** — the kind that finds the edges of a
page, squares up the angle you were holding the phone at, and evens out the
lighting. It hands back the cover on its own, with no table, no hand, no
shadow and no background, which is the whole difference.

Both phones have one already, free:

- **iPhone** — Notes, start a note, tap the camera icon, *Scan Documents*.
  (iOS 26's Preview app has the same scanner.)
- **Android** — Google Drive, tap **+**, then *Scan*.

Adobe Scan and OneDrive both work too if you prefer them. Microsoft Lens was
the obvious answer until Microsoft retired it in February 2026 — it is gone
from both app stores, so don't go looking for it.

## Taking the shot

1. Cover flat on a plain surface. Any colour, as long as it is not the same
   colour as the cover.
2. Phone **parallel** to the book, straight above it — not leaning in at an
   angle. The scanner corrects a slight tilt; it cannot invent the part of the
   cover a steep angle hid.
3. Fill most of the frame with the book.
4. Indirect daylight. **No flash** — it blows out a glossy cover and throws
   your own shadow across a matte one.
5. Let the app find the edges itself. Nudge its corners only if it has clearly
   missed. Export as JPEG or PNG.

That is all of it. The shops whose covers look best are not doing anything
more than this — their filenames give them away as phone scans and WhatsApp
photos.

## Then upload it

Add the photo in the portal as usual. The cropper opens with the book's four
corners already found; drag them if it has picked the wrong thing.

**One step is not automatic.** The portal stores the photo you upload and
nothing else — the sized versions the shop actually serves are made by a
script, because the image library it needs cannot run on Cloudflare's edge.
So after adding covers, run:

```
node scripts/resize-covers.mjs                    # all of them
node scripts/resize-covers.mjs --only=<slug>      # just the new book
npx wrangler d1 execute assubki-books --remote --file=<the SQL it prints>
```

Until that runs, the new cover still shows — the shop falls back to the
original photo — but at full file size and cropped by the browser rather than
cut to the frame.

## Why the frame is 5:7

Every public cover is cropped to 5:7. That is not a guess: across the 209
covers in the catalogue the median shape is 0.713, and the middle half runs
0.677 to 0.741. 5:7 is 0.714.

It was 3:4 (0.750), which sat above nearly all of them and shaved the foot off
every cover. The average cover now loses 4.5% to the crop instead of 6.4%, and
the number losing more than a tenth of itself fell from 50 to 12.

2:3 (0.667) is what the tidiest bookshops use and it is worse here — 6.6% —
because their books are a different shape from these. If the catalogue's mix
changes a lot, measure again rather than assuming; the numbers above came from
`book_images.width` and `.height`.

A cover is cropped from the **top** when it has to lose something, because the
title is nearly always at the top and the decoration at the foot.
