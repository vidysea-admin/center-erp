// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-87";
export const RELEASE_NOTE =
  "QA-157 (Umesh 15/08: 'jo kuch bhi media jaye - photo, certificate PDF, sab " +
  "compress'). Compression now lives at the ONE door every write passes " +
  "(storage.putFile) so no screen can bypass it: images via sharp (longest " +
  "edge 1600, q75, EXIF baked, PNG->JPEG when opaque, HEIC->JPEG when " +
  "decodable), PDFs via Ghostscript /ebook (in the container image), video " +
  "left for the device (next release, recorded needs_compression). Every " +
  "StoredFile row records original vs stored bytes and the label of the pass " +
  "- 'none:gs unavailable' rather than silence. Knobs in Admin (Media " +
  "compression): image_max_px, image_quality, pdf_compress. Admin storage " +
  "panel shows tools present, totals stored vs before, last 20 uploads. " +
  "Browser: HEIC decoded via heic2any before the usual downscale; the daily " +
  "log shows 'photo.jpg: 3.8 MB -> 420 KB' after each upload.";
