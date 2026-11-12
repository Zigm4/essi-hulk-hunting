"""Offline tests for tools/build_survey.py (no Discord). Run: python3 tests/test_build_survey.py"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'tools'))
import build_survey as B  # noqa: E402

_next = [1569000000000000000]


def mid(minutes):
    """Snowflake `minutes` after a fixed origin (ids must grow with time)."""
    return str(_next[0] + (int(minutes * 60 * 1000) << 22))


def msg(user=None, content='', title='', desc='', fields=None, footer=''):
    return {'user': user, 'content': content, 'title': title, 'desc': desc, 'fields': fields or {}, 'footer': footer,
            'mentions': [], 'reactions': []}


def move(player, vessel, oc, rc, fast=True, outward=True):
    speed = "You're on FAST mode which consumes supplies." if fast else "You're operating on SLOW speed (toggle the FAST lever !31)."
    return msg('⚫ UPBOT ⚫', desc=f'@{player} 👑 moved {"outward" if outward else "inward"} to a new position in the solar '
                                f'system. VESSEL {vessel} You now have 9.2 core ASTRO-SAVVY skill.',
               fields={'SECTOR (Oc)': f'{oc} ( Dootnootus )', 'DISTANCE (Rc)': f'{rc} (SL)', 'SPEED': speed})


M = {}
t = 0


def add(rec, step=1.0):
    global t
    t += step
    M[mid(t)] = rec


add(move('Roxy', 'SOLT-10', 4, 49, fast=False))
add(msg('Roxy ◊', '.25'))
add(msg('⚫ UPBOT ⚫', title='SOLT-10: Available Comms Hardpoints', desc='Hardpoint 0: Transmit map data.'))
add(msg(None, 'SHORT range HULK scanning. Please wait...'), 0.1)
add(msg(None, 'No derelict hulks detected within scanner range.'), 0.01)
add(msg('Roxy ◊', '.25'))
add(msg('⚫ UPBOT ⚫', 'SOLT-10: TRIANGULATION 1/3 locked at Oc 4 / Rc 49 . (-6 helium) Fly to a new Oc , at least 50 Rc away, and pull again.'))
add(move('Roxy', 'SOLT-10', 5, 100))
add(move('Roxy', 'SOLT-10', 5, 107))          # 100 → 107 : ⌈100^0.4⌉ = 7
add(msg('Roxy ◊', '.25'))
add(msg(None, 'SOLT-10: Calibration drifted \u2014 the signal slipped out of phase. [KNW roll 95 vs 60.024] (-6 helium) Try the same point again.'))
add(msg('Roxy ◊', '.25'))
add(msg(None, 'SOLT-10: TRIANGULATION 2/3 locked at Oc 5 / Rc 107 . (-6 helium)'))
add(move('Roxy', 'SOLT-10', 6, 47, outward=False))
add(msg('Roxy ◊', '.25'))
add(msg(None, 'SOLT-10: SIGNAL DECODED \u2014 TRIANGULATION COMPLETE The triad resolves a sealed cipher: TRD-TEST-0001 '
              '(quality: GREEN) A raw CRYP packet bleeds out of the array: +4 Encrypted Data . From inside any vessel '
              'use !unpack cipher TRD-TEST-0001 to resolve the triangle.'))
add(msg('Roxy ◊', '!unpack cipher TRD-TEST-0001'))
add(msg('⚫ UPBOT ⚫', 'Cipher TRD-TEST-0001 decoded. A derelict has resolved inside the triangle \u2014 coordinates sent to your DMs ( !enter mrtg-09 once you are there).'))
add(msg('Roxy ◊', '!enter mrtg-09'))
add(msg('⚫ UPBOT ⚫', 'You step through the airlock of mrtg-09.'), 0.2)
add(msg('Horst ◊', '.25'))
add(msg('⚫ UPBOT ⚫', title='SOLT-10: Available Comms Hardpoints'))
add(msg(None, 'SHORT range HULK scanning. Please wait...'), 0.1)

DM = """📡 **TRIADIC SIGNAL ARRAY \u2014 DECODE COMPLETE**
Cipher `TRD-TEST-0001` resolves inside its triangle to a cold hull that was not there before.

**ID:** `mrtg-09`
**Class:** MRT Goliath · PURPLE 🟣
**Status:** DEFENDED
**Sector (Oc):** 5
**Distance (Rc):** 70 SL
**Coords:** `5.00000070`
"""

rep = B.parse_dm_report(DM)
assert rep == {'code': 'mrtg-09', 'cipher': 'TRD-TEST-0001', 'class': 'MRT Goliath', 'color': 'PURPLE',
               'status': 'DEFENDED', 'exact': [5, 70], 'coords': '5.00000070'}, rep
private = {}
assert len(B.add_dm_reports(DM + '\n' + DM.replace('mrtg-09', 'qnxs-07'), private)) == 2
assert private['hulks']['mrtg-09']['public'] is False
print('1 OK DM decode report parsed (class, colour, status, Oc/Rc), kept private by default')

s = B.build(M, B.merge_manual({}, private))
h = s['hulks'][0]
assert (h['code'], h['cipher'], h['quality'], h['player'], h['vessel']) == ('mrtg-09', 'TRD-TEST-0001', 'GREEN', 'Roxy', 'SOLT-10'), h
assert h['vertices'] == [[4, 49], [5, 107], [6, 47]], h['vertices']
assert h['encrypted_data'] == 4 and h['decoded_by'] == 'Roxy'
assert h['exact'] is None and h['exact_known'] and (h['hull_class'], h['hull_color'], h['status']) == ('MRT Goliath', 'PURPLE', 'DEFENDED')
private['hulks']['mrtg-09']['public'] = True
assert B.build(M, B.merge_manual({}, private))['hulks'][0]['exact'] == [5, 70]
print('2 OK triangle rebuilt from locks + completion position, cipher → code, exact position only when public')

assert [x['result'] for x in s['scans']] == ['empty', 'no_reply']
assert (s['scans'][0]['oc'], s['scans'][0]['rc'], s['scans'][0]['player']) == (4, 49, 'Roxy')
assert s['scans'][1]['player'] == 'Horst' and s['scans'][1]['vessel'] == 'SOLT-10'
print('3 OK sweeps: position of the scanning vessel, signaller, empty vs no reply')

cal = [(c['result'], c.get('roll')) for c in s['calibration']]
assert cal == [('lock', None), ('drift', 95), ('lock', None), ('lock', None)], cal
assert s['players']['Roxy']['knw_personal'] == 0.024
assert s['entries'] and s['entries'][0]['code'] == 'mrtg-09' and s['entries'][0]['replies'][0].startswith('You step')
assert s['hulks'][0]['entries'] == [s['entries'][0]['time']]
assert s['fast_jumps']['match_law'] == 1 and all(j['from'] != 100 for j in s['fast_jumps']['mismatches'])   # 100 → 107 follows the law
assert s['open_triangulations'] == []
print('4 OK calibration log (locks, drift roll 95 vs 60.024 → KNW 0.024), !enter captured with replies, fast-jump law')

manual = {'extra_hulks': [{'code': 'qnxs-03', 'cipher': 'TRD-5XYD-UJPR', 'quality': 'BLUE', 'vertices': [[2, 164], [3, 215], [4, 163]]},
                          {'code': 'mrtg-09', 'cipher': 'TRD-TEST-0001'}]}
s2 = B.build(M, manual)
assert sorted(h['code'] for h in s2['hulks']) == ['mrtg-09', 'qnxs-03']   # no duplicate
assert B.clean_name('@bartleby  👑') == 'bartleby' and B.clean_name('Roxy ◊') == 'Roxy'
assert [B.fast_jump(r) for r in (30, 50, 160, 210)] == [4, 5, 8, 9]
print('5 OK extra hulks merged without duplicates, names cleaned, jump law')
print('All tests pass.')
