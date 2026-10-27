"""wordfreq のデータ（msgpack）を読むための最小限のデコーダ。
pip で msgpack を入れられない環境でも動くように、必要な型だけ実装している。"""
import struct


def unpackb(data: bytes):
    value, _ = _read(data, 0)
    return value


def _read(b, i):
    t = b[i]
    i += 1
    if t <= 0x7f:                      # positive fixint
        return t, i
    if 0x80 <= t <= 0x8f:              # fixmap
        return _map(b, i, t & 0x0f)
    if 0x90 <= t <= 0x9f:              # fixarray
        return _array(b, i, t & 0x0f)
    if 0xa0 <= t <= 0xbf:              # fixstr
        n = t & 0x1f
        return b[i:i + n].decode('utf-8'), i + n
    if t >= 0xe0:                      # negative fixint
        return t - 0x100, i
    if t == 0xc0: return None, i
    if t == 0xc2: return False, i
    if t == 0xc3: return True, i
    if t == 0xcc: return b[i], i + 1
    if t == 0xcd: return struct.unpack_from('>H', b, i)[0], i + 2
    if t == 0xce: return struct.unpack_from('>I', b, i)[0], i + 4
    if t == 0xcf: return struct.unpack_from('>Q', b, i)[0], i + 8
    if t == 0xd0: return struct.unpack_from('>b', b, i)[0], i + 1
    if t == 0xd1: return struct.unpack_from('>h', b, i)[0], i + 2
    if t == 0xd2: return struct.unpack_from('>i', b, i)[0], i + 4
    if t == 0xcb: return struct.unpack_from('>d', b, i)[0], i + 8
    if t in (0xd9, 0xda, 0xdb):        # str8 / str16 / str32
        size = {0xd9: 1, 0xda: 2, 0xdb: 4}[t]
        n = int.from_bytes(b[i:i + size], 'big')
        i += size
        return b[i:i + n].decode('utf-8'), i + n
    if t in (0xdc, 0xdd):              # array16 / array32
        size = 2 if t == 0xdc else 4
        n = int.from_bytes(b[i:i + size], 'big')
        return _array(b, i + size, n)
    if t in (0xde, 0xdf):              # map16 / map32
        size = 2 if t == 0xde else 4
        n = int.from_bytes(b[i:i + size], 'big')
        return _map(b, i + size, n)
    raise ValueError(f'unsupported msgpack type 0x{t:02x} at {i - 1}')


def _array(b, i, n):
    out = []
    for _ in range(n):
        v, i = _read(b, i)
        out.append(v)
    return out, i


def _map(b, i, n):
    out = {}
    for _ in range(n):
        k, i = _read(b, i)
        v, i = _read(b, i)
        out[k] = v
    return out, i
