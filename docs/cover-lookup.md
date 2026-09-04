# Cover lookup

The owner-facing picker uses two independent sources. It does not copy a remote
URL into the listing: every candidate is reviewed, cropped if necessary, and
uploaded through the same path as a photograph.

## Sources

### Open Library

The Search API returns works and usually exposes one representative `cover_i`.
That was the original implementation and explains why searches often produced
only a few pictures. The picker now ranks the work matches and asks the Editions
API for the four best works, producing up to eight distinct edition covers.

- Search API: <https://openlibrary.org/dev/docs/api/search>
- Editions endpoint: <https://openlibrary.org/dev/docs/restful_api>
- Cover image API: <https://openlibrary.org/dev/docs/api/covers>

Open Library needs no key. If its search is unavailable, the response reports an
outage instead of saying that the book has no matches.

### Google Books

Google Books is the second source. Its volume search supplies provider-owned
volume ids and cover image links in relevance order. The site keeps those
results in a separate group and proxies only a validated volume id; it never
accepts an arbitrary image URL.

- API usage and query parameters: <https://developers.google.com/books/docs/v1/using>
- Volume and image fields: <https://developers.google.com/books/docs/v1/reference/volumes>
- Required branding and result treatment: <https://developers.google.com/books/branding>

Google requires an API key for public-data requests. See `SETUP.md` for the
`GOOGLE_BOOKS_API_KEY` setup. Without it, Open Library continues to work and the
admin explains that the second source is not connected.

Google results must remain in Google's order, must not be intermixed with a
third-party result set, must display the supplied Powered by Google graphic, and
each result must link prominently to Google Books. Do not collapse the two
provider sections into one ranked grid.

## Why not WorldCat?

WorldCat's search APIs are subscription services for qualifying libraries, and
OCLC explicitly says that it does not provide or license cover art through the
WorldCat Search API. It is therefore not a practical cover source for this shop.

- <https://www.oclc.org/developer/api/oclc-apis/worldcat-search-api.en.html>
- <https://help.oclc.org/Discovery_and_Reference/WorldCat_Discovery/Troubleshooting/Can_I_get_cover_art_images_via_the_WorldCat_Search_API>

## Failure behavior

Each provider has one of three states: `available`, `unavailable`, or (for
Google) `not-configured`. Providers run independently, so a temporary Open
Library outage can still return Google results and vice versa. The admin calls
an outage an outage; it uses “Nothing found” only when connected sources
answered successfully.
