"""Measure real FFmpeg output using simultaneous video flashes/audio pulses."""
import importlib.util
import json
import math
from pathlib import Path
import shutil
import statistics
import struct
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_bridge', Path(__file__).with_name('player_bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/ffprobe required for media integration test')
class SyncTest(unittest.TestCase):
    def run_media(self, command):
        return subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30).stdout

    def events(self, path, audio_index):
        streams = json.loads(self.run_media(['ffprobe','-v','error','-show_streams','-of','json',str(path)]))['streams']
        audio = [s for s in streams if s['codec_type']=='audio'][audio_index]
        frames = json.loads(self.run_media(['ffprobe','-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
        pixels = self.run_media(['ffmpeg','-v','error','-threads','1','-i',str(path),'-map','0:v:0','-vf','scale=1:1','-fps_mode','passthrough','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'])
        flashes = [float(frame['best_effort_timestamp_time']) for frame,value in zip(frames,pixels) if value>180]
        raw = self.run_media(['ffmpeg','-v','error','-threads','1','-i',str(path),'-map',f'0:a:{audio_index}','-ac','1','-ar','48000','-f','s16le','pipe:1'])
        samples = struct.unpack('<'+'h'*(len(raw)//2),raw)
        pulses=[];active=False
        for i in range(0,len(samples)-480,480):
            present=math.sqrt(sum(value*value for value in samples[i:i+480])/480)>2000
            if present and not active:pulses.append(float(audio.get('start_time',0))+i/48000)
            active=present
        return flashes,pulses

    def test_multiple_tracks_preserve_sync_and_source_time_after_seek(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.mkv'
            self.run_media(['ffmpeg','-v','error','-y','-f','lavfi','-i',"color=black:s=64x64:r=25:d=6,drawbox=color=white:t=fill:enable='lt(mod(t,1),0.04)'",'-f','lavfi','-i',r'aevalsrc=sin(2*PI*1000*t)*lt(mod(t\,1)\,0.04):s=48000:d=6','-filter_complex','[1:a]asplit[a][b];[b]asetpts=PTS+0.32/TB[late]','-map','0:v','-map','[a]','-map','[late]','-c:v','libx264','-preset','ultrafast','-g','50','-bf','2','-threads','1','-c:a','ac3',str(source)])
            for track in (1,2):
                source_flashes,source_pulses=self.events(source,track-1)
                original_delta=statistics.median(min(source_pulses,key=lambda p:abs(p-f))-f for f in source_flashes[1:-1])
                for start in (0,2.37):
                    with self.subTest(track=track,start=start):
                        command=bridge.audio_command(str(source),track,start,True)
                        # Tests read their local disposable fixture; the public bridge
                        # retains its HTTP-only protocol allowlist.
                        command[command.index('-protocol_whitelist')+1]+=',file'
                        media=self.run_media(command)
                        output=Path(directory)/f'output-{track}-{start}.mp4';output.write_bytes(media)
                        flashes,pulses=self.events(output,0)
                        relevant=[f for f in flashes if f>start+.5 and f<5]
                        self.assertTrue(relevant)
                        for flash in relevant:
                            delta=min(pulses,key=lambda p:abs(p-flash))-flash
                            self.assertLess(abs(delta-original_delta),.035,(start,track,delta,original_delta))
                            # Non-keyframe seeks must not rebase movie time to zero.
                            self.assertLess(abs(flash-round(flash)),.035)

if __name__=='__main__':unittest.main()
