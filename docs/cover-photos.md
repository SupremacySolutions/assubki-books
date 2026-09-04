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
5. **Square the book in the frame.** More margin down one side than the other
   is the one fault nothing downstream can fix - the pipeline never moves
   artwork inside a picture, so a cover scanned off-centre stays off-centre in
   every frame it is put in. The three al-Hidayah covers had 30px of field
   down one side and none down the other, and had to be re-cut by hand.
6. Let the app find the edges itself. Nudge its corners only if it has clearly
   missed. Export as JPEG or PNG.

## How big it needs to be

The largest thing the shop builds is 840x1176, so anything narrower than about
**840px across the cover** is being enlarged to fill it, and no processing puts
back detail the photograph never had. The portal keeps up to 1400 on the long
edge, which is roughly 1000x1400 for a book - that is the size worth aiming
for, and any phone of the last ten years clears it easily.

The catalogue's own worst covers are 162 to 179px across. **Books → sort by
"Poorest cover first"** ranks every listing by this, and a row says
`cover 162px of 600` when it falls short of what the card alone asks for.

That is all of it. The shops whose covers look best are not doing anything
more than this — their filenames give them away as phone scans and WhatsApp
photos.

## Then upload it

Add the photo in the portal as usual. The cropper opens with the book's four
corners already found; drag them if it has picked the wrong thing.

That is the whole job now. The portal frames the photo to 5:7 and cuts the
five sizes the shop serves before the upload leaves the browser, so the
listing is right the moment it is saved.

It did not always. The portal used to store the photo and nothing else, and
the sized versions were made later by `scripts/resize-covers.mjs` - so until
somebody remembered to run it, `?p=card` fell back to the full-size original
and the browser cropped it however `object-fit` saw fit. That script is still
the way to reprocess the catalogue in bulk, and still the only thing that
trims scanner borders, but it is no longer a step you owe after every upload:

```
node scripts/resize-covers.mjs                    # all of them
node scripts/resize-covers.mjs --only=<slug>      # one book
npx wrangler d1 execute assubki-books --remote --file=<the SQL it prints>
```

Whenever it rewrites covers, bump `IMAGE_VERSION` in `src/lib/image-presets.ts`
or nobody who has already opened the shop will see the difference.

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

A cover that is only slightly taller than 5:7 shares the small crop between its
top and bottom so a printed border stays balanced. If it is much taller, it is
anchored at the top and loses the excess from the foot, protecting the title.
