"""Install on the existing separate DIMovie Micro host, using sudo."""
from pathlib import Path
import subprocess

run = lambda *args: subprocess.run(args, check=True)
stage = Path(__file__).resolve().parent
assert not Path('/etc/nginx/sites-available/donbot').exists(), 'Wrong host'
run('apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg')
run('install', '-d', '-m', '755', '/opt/dimovie-player')
run('install', '-m', '644', str(stage / 'player_bridge.py'), '/opt/dimovie-player/player_bridge.py')
for module in ('lifecycle.py', 'monitor.py'):
    run('install', '-m', '644', str(stage / module), '/opt/dimovie-player/' + module)
run('install', '-m', '644', str(stage / 'dimovie-player.service'), '/etc/systemd/system/dimovie-player.service')
site = Path('/etc/nginx/sites-available/moviesplayer')
text = site.read_text()
marker = ' location ^~ /dimovie-player/ {\n'
assert text.count(marker) == 1
if 'proxy_set_header X-Real-IP $remote_addr;' not in text.split(marker)[1].split('}')[0]:
    site.write_text(text.replace(marker, marker + '  proxy_set_header X-Real-IP $remote_addr;\n'))
# Public torrent metadata must not fetch private-network/instance-metadata URLs.
drop_in = Path('/etc/systemd/system/moviesplayer-torrserver.service.d')
drop_in.mkdir(exist_ok=True)
(drop_in / 'public-network.conf').write_text('''[Service]
IPAddressDeny=10.0.0.0/8
IPAddressDeny=172.16.0.0/12
IPAddressDeny=192.168.0.0/16
IPAddressDeny=169.254.0.0/16
IPAddressDeny=100.64.0.0/10
IPAddressDeny=fc00::/7
IPAddressDeny=fe80::/10
''')
run('nginx', '-t')
run('systemctl', 'daemon-reload')
# Do not restart the shared engine (or discard its cache) for a bridge update.
run('systemctl', 'restart', 'dimovie-player')
run('systemctl', 'reload', 'nginx')
print('Guest player installed; administration endpoint remains password protected.')
