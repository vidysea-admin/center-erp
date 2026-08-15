// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-91";
export const RELEASE_NOTE =
  "Compress-first video, on the device (Umesh: 'pehle compress phir upload - " +
  "highest compression, par chehre pehchane jaayen'). Admin knobs video_compress / " +
  "video_max_height 720 / video_bitrate_kbps 1500 / video_audio_kbps 64 (~11-12 MB " +
  "per minute). Daily Execution gets 'Record video' - the clip is recorded IN the " +
  "app at those targets (compressed at source, nothing to transcode) and goes " +
  "straight into the upload path (resumable when Drive is on). A gallery clip is " +
  "re-encoded in the browser (canvas + MediaRecorder, no dependency) before it " +
  "travels; already-small clips are left alone; browsers that cannot re-encode " +
  "send the original via the resumable path and the row says needs_compression. " +
  "The StoredFile row records what the device did (client:video-720p-1500k + " +
  "original size).";
