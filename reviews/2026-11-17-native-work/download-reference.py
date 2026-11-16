from pathlib import Path
import hashlib
import json
import urllib.request

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
results = []
for name in ['utf8proc.c', 'utf8proc.h', 'utf8proc_data.c', 'LICENSE.md']:
    url = 'https://raw.githubusercontent.com/JuliaStrings/utf8proc/v2.11.3/' + name
    body = urllib.request.urlopen(url, timeout=30).read()
    (out / ('upstream-' + name)).write_bytes(body)
    local = root / 'native/mozc/third_party/utf8proc' / name
    results.append({'file': name, 'url': url, 'byteEqual': body == local.read_bytes(),
                    'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
for name, url in [
    ('GraphemeBreakTest.txt', 'https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakTest.txt'),
    ('NormalizationTest.txt', 'https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt'),
]:
    body = urllib.request.urlopen(url, timeout=30).read()
    (out / name).write_bytes(body)
    results.append({'file': name, 'url': url, 'bytes': len(body),
                    'sha256': hashlib.sha256(body).hexdigest()})
(out / 'reference-downloads.json').write_text(json.dumps(results, indent=2), encoding='utf8')
print(json.dumps(results, indent=2))
