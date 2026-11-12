"""Build docs/data/survey.json from an archive of #spacecraft messages.

ESSI Deep Survey Division: derelict (HULK) intelligence pipeline.

The archive is a JSON file produced by the scanner (kept private, outside this
repository):
    {"channel": "spacecraft", "messages": {"<snowflake id>": {
        "user": "Roxy ◊" | null, "content": "...", "title": "...", "desc": "...",
        "footer": "...", "fields": {"SECTOR (Oc)": "5 ( Biscittarius )", ...},
        "mentions": [...], "reactions": [...]}}}
`user` is null for messages grouped under the previous author (Discord shows
the name once); it is carried forward in id order.

Manual intelligence (exact positions received by DM, notes) lives in
data/manual.json and is merged in. Standard library only.

    python3 tools/build_survey.py --archive /path/to/spacecraft_archive.json
"""
import argparse
import json
import math
import os
import re
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'docs', 'data', 'survey.json')
MANUAL = os.path.join(ROOT, 'data', 'manual.json')
PRIVATE = os.path.join(ROOT, 'data', 'private.json')   # DM reports: git-ignored, never published as is
DISCORD_EPOCH_MS = 1420070400000
SCAN_RANGE = 32           # SSCAN: 32 SL, same sector (dev announcement)
SCAN_MAX_RESULTS = 2
ATTRIBUTION_WINDOW_S = 300

CALLSIGN = r'[A-Z]{3,5}-\d+'
RE_MOVE = re.compile(r'@(.+?)\s+moved\s+(outward|inward).*?VESSEL\s+(' + CALLSIGN + ')', re.S)
RE_SYSCHECK = re.compile(r'SYSTEMS CHECK:\s*Coordinates\s*Oc\s*(\d+)\s*,\s*Rc\s*(\d+)')
RE_SYSCHECK_SHIP = re.compile(r'(?:resource check for|VESSEL CALLSIGN:)\s*(' + CALLSIGN + ')')
RE_PILOT = re.compile(r'PILOT:\s*([A-Za-z0-9_.]+?)(?:#\d+)?\s')
RE_LOCATION = re.compile(r'Current location:\s*>\s*([A-Z][A-Z ]+?)\s*<')
RE_DOCKED = re.compile(r'made to ([A-Z][A-Z ]+?)\.')
RE_ORBIT = re.compile(r'NOW ORBITING:\s*>\s*([A-Z][A-Z ]+?)\s*<.*?Current coordinates:\s*(\d+(?:\.\d+)?)', re.S)
RE_MENU = re.compile(r'^\s*(' + CALLSIGN + r'):\s*Available Comms Hardpoints')
RE_LOCK = re.compile(r'(' + CALLSIGN + r'):\s*.*?TRIANGULATION\s*(\d)\s*/\s*(\d)\s*locked at\s*Oc\s*(\d+)\s*/\s*Rc\s*(\d+)')
RE_DRIFT = re.compile(r'(' + CALLSIGN + r'):\s*Calibration drifted.*?KNW roll\s*(\d+)\s*vs\s*([\d.]+)')
RE_REJECT = re.compile(r'(' + CALLSIGN + r'):\s*Calibration rejected\s*[\u2014-]?\s*(.*)')
RE_COMPLETE = re.compile(r'(' + CALLSIGN + r'):\s*.*?SIGNAL DECODED.*?sealed cipher:\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)'
                         r'\s*\(\s*quality:\s*([A-Za-z]+)\s*\)(?:.*?\+\s*(\d+)\s*Encrypted Data)?', re.S)
RE_DECODED = re.compile(r'Cipher\s+([A-Z0-9]+(?:-[A-Z0-9]+)+)\s+decoded.*?[.!]enter\s+([A-Za-z0-9_-]+)', re.S)
RE_ENTER_CMD = re.compile(r'^\s*[.!]enter\s+([A-Za-z0-9_-]+)', re.I)
RE_COMMAND = re.compile(r'^\s*[.!]\S')
SCANNING = 'HULK scanning'
NO_HULK = 'No derelict hulks detected'


def parse_coords(text):
    """Game coordinates `Oc.RRRRRRRR` (Oc + Rc / 100,000,000, trailing zeros dropped): '2.0000003' → (2, 30)."""
    try:
        value = float(text)
    except ValueError:
        return None, None
    oc = int(value)
    return oc, int(round((value - oc) * 1e8))


def snowflake_time(mid):
    return datetime.fromtimestamp(((int(mid) >> 22) + DISCORD_EPOCH_MS) / 1000, tz=timezone.utc)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def clean_name(name):
    """'Roxy ◊' → 'Roxy', '@bartleby  👑' → 'bartleby'."""
    return re.sub(r'[^A-Za-z0-9_.-]', '', (name or '').replace('@', ' ').split('#')[0]).strip() or None


def first_int(text):
    m = re.search(r'\d+', text or '')
    return int(m.group()) if m else None


def fast_jump(rc):
    """SL covered by one FAST jump leaving Rc `rc` (law measured on #spacecraft)."""
    return math.ceil(max(rc, 1) ** 0.4)


def full_text(rec):
    parts = [rec.get('content') or '', rec.get('title') or '', rec.get('desc') or '']
    parts += [f'{k} {v}' for k, v in (rec.get('fields') or {}).items()]
    parts.append(rec.get('footer') or '')
    return ' '.join(p for p in parts if p)


class Survey:
    def __init__(self):
        self.pos = {}                 # vessel → [oc, rc]
        self.speed = {}               # vessel → 'FAST' | 'SLOW'
        self.last_radial = {}         # vessel → rc after its last radial move (for jump checks)
        self.player_vessel = {}
        self.commands = []            # (time, player, text)
        self.last_menu = None         # (time, vessel)
        self.pending_scan = None
        self.pending_enter = []
        self.chains = {}              # (vessel, player) → [[oc, rc, iso], ...]
        self.sectors = {}
        self.hulks = []
        self.decodes = {}
        self.scans = []
        self.calibration = []
        self.entries = []
        self.stations = {}
        self.station_log = []         # every position read for a station or moon (planet model check)
        self.jumps = []
        self.players = {}
        self.first = self.last = None
        self.count = 0

    # --- helpers ------------------------------------------------------------
    def recent(self, pattern, t, window=ATTRIBUTION_WINDOW_S):
        for tt, p, c in reversed(self.commands):
            if (t - tt).total_seconds() > window:
                break
            if re.match(pattern, c, re.I):
                return p
        return None

    def set_pos(self, vessel, oc, rc):
        if not vessel or rc is None:
            return
        old = self.pos.get(vessel, [None, None])
        self.pos[vessel] = [oc if oc is not None else old[0], rc]

    def where(self, vessel):
        return list(self.pos.get(vessel, [None, None]))

    def player(self, name):
        if name:
            self.players.setdefault(name, {'name': name})
        return name

    # --- one message --------------------------------------------------------
    def feed(self, mid, rec, user):
        t = snowflake_time(mid)
        self.first = self.first or t
        self.last = t
        self.count += 1
        text = full_text(rec)
        content = rec.get('content') or ''
        fields = rec.get('fields') or {}
        is_bot = user is not None and 'UPBOT' in user.upper()

        if not is_bot and RE_COMMAND.match(content) and not rec.get('title') and not fields:
            p = self.player(clean_name(user))
            self.commands.append((t, p, content.strip()))
            m = RE_ENTER_CMD.match(content)
            if m:
                entry = {'time': iso(t), 'player': p, 'vessel': self.player_vessel.get(p), 'code': m.group(1).lower(),
                         'replies': [], '_t': t}
                self.entries.append(entry)
                self.pending_enter.append(entry)
            return
        for e in list(self.pending_enter):          # bot answers to !enter
            if (t - e['_t']).total_seconds() > 90 or len(e['replies']) >= 3:
                self.pending_enter.remove(e)
            elif is_bot or user is None:
                e['replies'].append(text[:300])

        sec = fields.get('SECTOR (Oc)')
        if sec:
            m = re.match(r'\s*(\d+)\s*\(\s*([^)]+?)\s*\)', sec)
            if m:
                self.sectors[int(m.group(1))] = m.group(2)

        # positions
        if 'DISTANCE (Rc)' in fields:
            oc, rc = first_int(fields.get('SECTOR (Oc)')), first_int(fields['DISTANCE (Rc)'])
            mv = RE_MOVE.search(rec.get('desc') or text)
            if mv:
                p, v = self.player(clean_name(mv.group(1))), mv.group(3)
                self.player_vessel[p] = v
                self.players[p]['vessel'] = v
                speed = 'FAST' if 'FAST mode' in fields.get('SPEED', '') else 'SLOW'
                before = self.last_radial.get(v)
                if speed == 'FAST' and before is not None and before == self.pos.get(v, [None, None])[1] and rc != before:
                    self.jumps.append({'from': before, 'to': rc, 'delta': abs(rc - before), 'law': fast_jump(before),
                                       'vessel': v, 'time': iso(t)})
                self.set_pos(v, oc, rc)
                self.last_radial[v] = rc
                self.speed[v] = speed
            elif 'new SECTOR' in text:
                p = self.recent(r'[.!]5[12]\b', t, 120)
                v = self.player_vessel.get(p)
                if not (v and self.pos.get(v, [None, None])[1] == rc):
                    cands = [vv for vv, pp in self.pos.items() if pp[1] == rc]
                    v = cands[0] if len(cands) == 1 else None
                if v:
                    self.set_pos(v, oc, rc)
        sc = RE_SYSCHECK.search(text)
        if sc:
            ship = RE_SYSCHECK_SHIP.search(text)
            if ship:
                v = ship.group(1)
                self.set_pos(v, int(sc.group(1)), int(sc.group(2)))
                loc = RE_LOCATION.search(text)
                if loc:
                    self.station(loc.group(1), int(sc.group(1)), int(sc.group(2)), t, 'launch check')
        dk = RE_DOCKED.search(text)
        if dk:
            p = self.recent(r'[.!]\d+', t, 120)
            v = self.player_vessel.get(p)
            oc, rc = self.where(v)
            if rc is not None:
                self.station(dk.group(1), oc, rc, t, 'docking')
        ob = RE_ORBIT.search(text)
        if ob:
            oc, rc = parse_coords(ob.group(2))
            if oc:
                self.station(ob.group(1), oc, rc, t, 'orbit insertion')

        # comms: hardpoint menu, scanner
        m = RE_MENU.match(rec.get('title') or content)
        if m:
            self.last_menu = (t, m.group(1))
        if SCANNING in content:
            v = self.last_menu[1] if self.last_menu and (t - self.last_menu[0]).total_seconds() < 90 else None
            oc, rc = self.where(v)
            self.pending_scan = {'time': iso(t), 'vessel': v, 'player': self.recent(r'[.!]25\b', t, 240),
                                 'oc': oc, 'rc': rc, 'range': SCAN_RANGE, 'result': 'no_reply', 'text': '', '_t': t}
            self.scans.append(self.pending_scan)
            return
        if self.pending_scan and (t - self.pending_scan['_t']).total_seconds() < 45 and 'hulk' in text.lower():
            self.pending_scan['result'] = 'empty' if NO_HULK in text else 'hits'
            self.pending_scan['text'] = text[:300]
            self.pending_scan = None
            return

        # triangulation
        lk = RE_LOCK.search(content)
        if lk:
            v, step, oc, rc = lk.group(1), int(lk.group(2)), int(lk.group(4)), int(lk.group(5))
            p = self.player(self.recent(r'[.!]25\b', t))
            self.set_pos(v, oc, rc)
            key = (v, p)
            if step == 1 or key not in self.chains:
                self.chains[key] = []
            self.chains[key].append([oc, rc, iso(t)])
            self.calibration.append({'time': iso(t), 'player': p, 'vessel': v, 'oc': oc, 'rc': rc,
                                     'result': 'lock', 'step': step})
            return
        dr = RE_DRIFT.search(content)
        if dr:
            v = dr.group(1)
            p = self.player(self.recent(r'[.!]25\b', t))
            oc, rc = self.where(v)
            threshold = float(dr.group(3))
            self.calibration.append({'time': iso(t), 'player': p, 'vessel': v, 'oc': oc, 'rc': rc, 'result': 'drift',
                                     'roll': int(dr.group(2)), 'threshold': threshold})
            if p:
                self.players[p]['knw_personal'] = round(threshold - 60, 3)
                self.players[p]['threshold'] = threshold
            return
        rj = RE_REJECT.search(content)
        if rj:
            v = rj.group(1)
            oc, rc = self.where(v)
            self.calibration.append({'time': iso(t), 'player': self.player(self.recent(r'[.!]25\b', t)), 'vessel': v,
                                     'oc': oc, 'rc': rc, 'result': 'rejected', 'text': rj.group(2)[:200]})
            return
        cp = RE_COMPLETE.search(content)
        if cp:
            v = cp.group(1)
            p = self.player(self.recent(r'[.!]25\b', t))
            oc, rc = self.where(v)
            chain = self.chains.pop((v, p), None) or self.chains.pop((v, None), None) or []
            vertices = [[c[0], c[1]] for c in chain[-2:]] + [[oc, rc]]
            vertex_times = [c[2] for c in chain[-2:]] + [iso(t)]
            self.calibration.append({'time': iso(t), 'player': p, 'vessel': v, 'oc': oc, 'rc': rc,
                                     'result': 'lock', 'step': 3})
            self.hulks.append({'code': None, 'cipher': cp.group(2), 'quality': cp.group(3).upper(), 'player': p,
                               'vessel': v, 'vertices': vertices, 'vertex_times': vertex_times, 'completed': iso(t), 'decoded': None,
                               'decoded_by': None, 'encrypted_data': int(cp.group(4)) if cp.group(4) else None})
            return
        dc = RE_DECODED.search(text)
        if dc:
            self.decodes[dc.group(1)] = {'code': dc.group(2).lower(), 'time': iso(t),
                                         'by': self.recent(r'[.!]unpack', t)}

    def station(self, name, oc, rc, t, source):
        name = ' '.join(name.split()).title()
        self.stations[name] = {'name': name, 'oc': oc, 'rc': rc, 'seen': iso(t)}
        self.station_log.append({'time': iso(t), 'name': name, 'oc': oc, 'rc': rc, 'source': source})

    # --- result -------------------------------------------------------------
    def result(self, manual):
        for h in self.hulks:
            d = self.decodes.get(h['cipher'])
            if d:
                h.update(code=d['code'], decoded=d['time'], decoded_by=d['by'])
        known = {h['cipher'] for h in self.hulks}
        for cipher, d in self.decodes.items():      # decoded, completion not in the archive
            if cipher not in known:
                self.hulks.append({'code': d['code'], 'cipher': cipher, 'quality': None, 'player': None,
                                   'vessel': None, 'vertices': [], 'vertex_times': [], 'completed': None, 'decoded': d['time'],
                                   'decoded_by': d['by'], 'encrypted_data': None})
        known = {h['cipher'] for h in self.hulks} | {h['code'] for h in self.hulks if h['code']}
        for extra in manual.get('extra_hulks', []):  # seen elsewhere (DM report, own log…)
            if extra.get('cipher') not in known and extra.get('code') not in known:
                h = {'code': None, 'cipher': None, 'quality': None, 'player': None, 'vessel': None, 'vertices': [], 'vertex_times': [],
                     'completed': None, 'decoded': None, 'decoded_by': None, 'encrypted_data': None}
                h.update({k: v for k, v in extra.items() if k in h})
                h['source'] = extra.get('source', 'manual')
                self.hulks.append(h)
        mh = manual.get('hulks', {})
        for h in self.hulks:
            extra = mh.get(h['code'] or '') or mh.get(h['cipher']) or {}
            h['exact'] = extra.get('exact') if extra.get('public') else None
            h['exact_known'] = bool(extra.get('exact'))
            pr = extra.get('probable')
            h['probable'] = ({'oc': pr[0], 'rc': pr[1], 'confidence': extra.get('confidence'),
                              'evidence': extra.get('evidence')} if pr else None)
            h['hull_class'] = extra.get('class')
            h['hull_color'] = extra.get('color')
            h['status'] = extra.get('status')
            h['note'] = extra.get('note')
            h['entries'] = [e['time'] for e in self.entries if h['code'] and e['code'] == h['code']]
        for e in self.entries:
            e.pop('_t', None)
        for s in self.scans:
            s.pop('_t', None)
        for name, info in (manual.get('players') or {}).items():
            self.players.setdefault(name, {'name': name}).update(info)
        open_tri = [{'vessel': v, 'player': p, 'vertices': [[c[0], c[1]] for c in chain], 'times': [c[2] for c in chain],
                     'updated': chain[-1][2]}
                    for (v, p), chain in self.chains.items() if chain]
        good = sum(1 for j in self.jumps if j['delta'] == j['law'])
        return {
            'generated': iso(datetime.now(timezone.utc)),
            'coverage': {'from': iso(self.first) if self.first else None, 'to': iso(self.last) if self.last else None,
                         'messages': self.count, 'gaps': manual.get('gaps', [])},
            'sectors': {str(k): v for k, v in sorted(self.sectors.items())},
            'scanner': {'range': SCAN_RANGE, 'max_results': SCAN_MAX_RESULTS},
            'hulks': sorted(self.hulks, key=lambda h: h['decoded'] or h['completed'] or ''),
            'open_triangulations': open_tri,
            'scans': self.scans,
            'entries': self.entries,
            'calibration': self.calibration,
            'stations': sorted(self.stations.values(), key=lambda s: (s['rc'] or 0)),
            'station_log': self.station_log,
            'players': dict(sorted(self.players.items(), key=lambda kv: kv[0].lower())),
            'fast_jumps': {'samples': len(self.jumps), 'match_law': good,
                           'mismatches': [j for j in self.jumps if j['delta'] != j['law']][:50]},
        }


RE_DM = {
    'cipher': re.compile(r'Cipher\s+`?(TRD-[A-Z0-9]+(?:-[A-Z0-9]+)+)`?'),
    'code': re.compile(r'\bID:\s*`?([a-z]{3,5}-\d+)`?'),
    'class': re.compile(r'Class:\s*([^·\n]+?)\s*·\s*([A-Za-z]+)'),
    'status': re.compile(r'Status:\s*([A-Za-z][A-Za-z ]*?)\s*(?:\n|$)'),
    'oc': re.compile(r'Sector\s*\(Oc\):\s*(\d+)'),
    'rc': re.compile(r'Distance\s*\(Rc\):\s*(\d+)'),
    'coords': re.compile(r'Coords:\s*`?([\d.]+)`?'),
}


def parse_dm_report(text):
    """DM decode report (TRIADIC SIGNAL ARRAY ... DECODE COMPLETE) → dict, or None without an ID."""
    t = text.replace('**', '').replace('*', '')
    m = {k: rx.search(t) for k, rx in RE_DM.items()}
    if not m['code']:
        return None
    out = {'code': m['code'].group(1).lower()}
    if m['cipher']:
        out['cipher'] = m['cipher'].group(1)
    if m['class']:
        out['class'], out['color'] = m['class'].group(1).strip(), m['class'].group(2).upper()
    if m['status']:
        out['status'] = m['status'].group(1).strip().upper()
    if m['oc'] and m['rc']:
        out['exact'] = [int(m['oc'].group(1)), int(m['rc'].group(1))]
    if m['coords']:
        out['coords'] = m['coords'].group(1)
    return out


def add_dm_reports(text, manual):
    """Merge every DM report found in `text` into manual['hulks'] (exact position kept private)."""
    added = []
    for chunk in re.split(r'(?=TRIADIC SIGNAL ARRAY\s*[\u2014-]\s*DECODE COMPLETE)', text):
        rep = parse_dm_report(chunk)
        if not rep:
            continue
        entry = manual.setdefault('hulks', {}).setdefault(rep['code'], {})
        entry.update({k: v for k, v in rep.items() if k != 'code'})
        entry.setdefault('public', False)
        added.append(rep)
    return added


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def merge_manual(manual, private):
    """Public manual.json + private DM reports, per hulk code (private wins)."""
    out = dict(manual)
    hulks = {k: dict(v) for k, v in (manual.get('hulks') or {}).items()}
    for code, info in (private.get('hulks') or {}).items():
        hulks.setdefault(code, {}).update(info)
    out['hulks'] = hulks
    return out


def build(messages, manual=None):
    """messages: {id: record}; returns the survey dict."""
    survey = Survey()
    user = None
    for mid in sorted(messages, key=int):
        rec = messages[mid]
        user = rec.get('user') or user
        survey.feed(mid, rec, user)
    return survey.result(manual or {})


def main(argv=None):
    ap = argparse.ArgumentParser(description='Build docs/data/survey.json from a #spacecraft archive.')
    ap.add_argument('--archive', required=True)
    ap.add_argument('--manual', default=MANUAL)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--private', default=PRIVATE)
    ap.add_argument('--add-dm', metavar='FILE', help="merge pasted DM decode reports ('-' = stdin) into the private file")
    args = ap.parse_args(argv)
    private = load_json(args.private)
    if args.add_dm:
        import sys
        text = sys.stdin.read() if args.add_dm == '-' else open(args.add_dm, encoding='utf-8').read()
        reps = add_dm_reports(text, private)
        save_json(args.private, private)
        for r in reps:
            print(f"DM report {r['code']}: {r.get('class')} {r.get('color')} {r.get('status')} at {r.get('exact')} "
                  f"(private: set \"public\": true in {os.path.basename(args.private)} to publish the position)")
        if not reps:
            print('no DM report found')
    with open(args.archive, encoding='utf-8') as f:
        archive = json.load(f)
    manual = merge_manual(load_json(args.manual), private)
    survey = build(archive['messages'], manual)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(survey, f, ensure_ascii=False, indent=1)
    os.replace(tmp, args.out)
    c = survey['coverage']
    print(f"survey.json: {len(survey['hulks'])} hulks, {len(survey['scans'])} scans, "
          f"{len(survey['calibration'])} calibrations, {len(survey['entries'])} entries, "
          f"{c['messages']} messages {c['from']} → {c['to']}")
    return survey


if __name__ == '__main__':
    main()
