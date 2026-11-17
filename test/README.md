# Bundled audio

`test.wav` — 8kHz mono 16-bit PCM, the format Asterisk plays without
transcoding. Copied to the sound library as `campaign/test` the first time the
app starts, so a fresh install can place a test call before anything has been
uploaded. It is never overwritten afterwards: rename or replace it from the
Audio tab and it stays that way.

Keep it canonical — `fmt ` and `data` chunks only. Editors like to add `LIST`
metadata chunks, and some Asterisk builds will not play a WAV that has them.
