# Streaming resource policy

The site remains a browser HTML video client of one shared TorrServer. Torrent
traffic stays on the VPS. Compatible streams retain HTTP Range and direct byte
forwarding; FFmpeg copies video and encodes audio only when requested.

## Deployed bounds

- `Registry(max_viewers=1, max_torrents=1)`: intentionally unchanged capacity.
- 64 MiB RAM piece cache in the engine, 448 MiB engine cgroup maximum.
- Idle managed torrents are retained up to 60 seconds for immediate reuse and
  removed by the 30-second sweeper. Actual engine expiry can also discard cache.
- Idle OTHER torrents may be evicted immediately to admit a different movie.
- Active owners and open readers prevent eviction. Stop revokes that owner's
  links; another owner's readers are independent.
- Three media requests TOTAL across raw and audio paths; twelve bounded HTTP
  handlers leave room for control traffic during normal streaming. Unparsed or
  slow requests have a 30-second socket timeout; this is not a general DDoS shield.
- One FFmpeg job and one ffprobe. Old audio jobs are terminated and reaped before
  replacement. Protocols and demuxers are restricted; systemd limits the bridge
  and its children to loopback networking and 192 MiB, 60% CPU.
- Existing API URLs and the user interface are unchanged. Busy/resource pressure
  responses use 409/429/503, with Retry-After for 429/503.

The registry permits shared-hash viewers when explicitly configured in tests.
Production capacity MUST NOT be raised merely because these tests pass.

## Lifecycle

Add is single-flight by canonical info hash, including base32 magnets. An
operation ticket prevents a cancelled add from resurrecting a stopped session.
Refcounts belong to viewers and media readers, never to a global play position.
Readers keep a foreground/background-independent lease; each user still seeks
through their own Range or audio-offset request. Failed removals remain tracked
and are retried. No torrent with active readers is removed for cache pressure.

On restart, only engine entries carrying `data=dimovie-managed-v1` are removed.
Unknown/admin torrents are preserved. The bridge, not TorrServer, is restarted
for bridge updates. Existing pre-migration orphan entries require inspection;
the deploy must run only after the engine list is empty.

No video files or new disk cache are created. RAM reuse improves immediate
reopening, not full offline viewing. Disk cache is deferred: an engine disk
backend alone is not a proven global byte quota or safe active-piece eviction.

## Monitoring and admission

Every 30 seconds, a small atomic JSON snapshot is written to
`/run/dimovie-player/metrics.json` (private runtime directory, not an HTTP API).
It contains guest/viewer/torrent/reader/job counts, system available RAM, engine
and bridge cgroup memory, system CPU busy fraction, disk free, network rates,
and the configured cache budget. It contains no movie names, hashes or tokens.
Configured cache capacity is labelled as such, not misreported as cache usage.

New torrent admission is additionally rejected below 160 MiB available RAM,
below 2 GiB disk free, or above an observed 35 Mbit/s egress rate. These are
conservative guardrails, not a capacity benchmark. CPU is monitored but does not
automatically raise or lower viewer limits. Samples are approximate and 30
seconds old at worst in normal operation. Existing readers are not evicted.

## Decisions

| Idea | Benefit | Complexity/risk | Decision |
|---|---|---|---|
| Shared torrent and leases | High: avoids duplicate downloads and unsafe stop | Medium: lifecycle races | Implemented, multi-viewer activation gated |
| Warm bounded RAM cache | Medium: quick return without disk writes | Low | 64 MiB engine cache retained; 60 s idle grace |
| Disk cache | Potentially high for distant seek positions | High: global quota and active-piece eviction | Deferred |
| Automatic cleanup/restart reconciliation | High | Medium | Implemented for managed entries |
| Admission guardrails | High protection | Low; coarse sampled state | Implemented; hard capacity unchanged |
| Waiting queue | Limited on one viewer; needs cancellation/fairness UI | Medium | Deferred; bounded explicit retry response |
| Direct Range/backpressure | High | Low | Preserved; leases, 416 and disconnect tests added |
| Shared transcoded segments | Potentially high for identical audio/position | High: storage/segmentation/change of transport | Deferred |
| Monitor | High operational value | Low | Private 30 s snapshots |

## Validation and limits

Run `python -m unittest discover -s backend -v` and `npm test`. Backend tests use a
fake engine/local HTTP on the developer/CI host, never concurrent movies on the
production VPS. They cover shared viewers, independent cancellation/readers,
single-flight add, stop during add, warm-cache expiry, active-cache protection,
failed-delete retry, Range/416, media saturation, client disconnect and child
process reaping. Frontend presentation is unchanged.

Required future permission-gated measurements: 1 then 2 viewers of one torrent,
same/different positions, sustained direct/AAC playback, startup/rebuffer time,
cache hit rate, CPU throttling, RAM peaks, network peaks, cleanup after sleep or
restart. Consider two direct viewers as a test candidate, not a guarantee.
Ten/twenty viewers and multiple simultaneous audio encoders are not a credible
capacity promise for E2.1.Micro.

Do not assume Oracle permits every P2P use: consult the agreement applicable to
the tenancy and current service policies. This code does not establish rights
to redistribute films. Keep content/use authorised. Host/OCI peer port changes
are separate operational changes and are not made by this patch.
