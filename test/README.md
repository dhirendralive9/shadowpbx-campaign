# Bundled audio

`test.wav` — 8kHz mono 16-bit PCM, the format Asterisk plays without
transcoding. A built-in: copied to the sound library as `campaign/test` on
startup (and restored if it goes missing), so a fresh install can place a test
call before anything has been uploaded. The Audio tab shows it as locked — it
cannot be deleted, renamed or overwritten.

Keep it canonical — `fmt ` and `data` chunks only. Editors like to add `LIST`
metadata chunks, and some Asterisk builds will not play a WAV that has them.
