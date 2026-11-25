from __future__ import annotations

from dataclasses import dataclass

CRUSH_XP_THRESHOLD = 500
LOVER_XP_THRESHOLD = 700
SOULMATE_XP_THRESHOLD = 1000
SPECIAL_XP = 500
FLIRT_REQUIREMENT = 5
FLIRT_XP_BONUS = 25

BOND_LEVELS = {
    "stranger": {"level": 0, "label": "คนแปลกหน้า", "emoji": "👋"},
    "acquaintance": {"level": 1, "label": "คนรู้จัก", "emoji": "🤝", "unlock": "Acquaintance"},
    "friend": {"level": 2, "label": "เพื่อน", "emoji": "🙂", "unlock": "Friend"},
    "close_friend": {"level": 3, "label": "เพื่อนสนิท", "emoji": "🤗", "unlock": "Close Friend"},
    "crush": {"level": 4, "label": "แอบชอบ", "emoji": "💗", "unlock": "Crush"},
    "lover": {"level": 5, "label": "คนรัก", "emoji": "❤️", "unlock": "Lover"},
    "soulmate": {"level": 6, "label": "คู่แท้", "emoji": "💞", "unlock": "Soulmate"},
    "enemy": {"level": -1, "label": "ศัตรู", "emoji": "💢", "jump_to": "friend"},
    "sibling": {"level": 4, "label": "พี่น้อง", "emoji": "🌱", "max_level": 4, "unlock": "Sibling"},
    "family": {"level": 4, "label": "ครอบครัว", "emoji": "🏠", "max_level": 4, "unlock": "Family"},
}
ASCENDING = ["stranger", "acquaintance", "friend", "close_friend", "crush", "lover", "soulmate"]
XP_THRESHOLDS = {-1: -150, 0: -149, 1: 50, 2: 150, 3: 300, 4: 500, 5: 700, 6: 1000}
APPROVAL_NAMES = ("family", "sibling", "soulmate", "lover")


def is_bond(value: object) -> bool:
    return isinstance(value, str) and value in BOND_LEVELS


def bond_level(bond: str | None) -> int | None:
    return BOND_LEVELS[bond]["level"] if is_bond(bond) else None


def bond_label(bond: str | None) -> str:
    return BOND_LEVELS[bond]["label"] if is_bond(bond) else str(bond or "")


def bond_emoji(bond: str | None) -> str:
    return BOND_LEVELS[bond]["emoji"] if is_bond(bond) else ""


def is_bond_unlock(before: str | None, after: str | None) -> bool:
    if not is_bond(after) or not BOND_LEVELS[after].get("unlock"):
        return False
    if not is_bond(before):
        return True
    return before != after and BOND_LEVELS[after]["level"] >= BOND_LEVELS[before]["level"]


def is_capped_bond(bond: str) -> bool:
    return bond in {"sibling", "family"}


def bond_for_xp(xp: int) -> str:
    if xp <= -150: return "enemy"
    if xp < 50: return "stranger"
    if xp < 150: return "acquaintance"
    if xp < 300: return "friend"
    return "close_friend"


@dataclass
class BondDerivation:
    bond: str
    xp: int
    reason: str
    changed: bool
    consumed: list[str]


def relationship_permissions(bond: str | None, xp: int, flirt_count: int) -> dict[str, bool]:
    current = bond if is_bond(bond) else "stranger"
    capped = is_capped_bond(current)
    return {
        "lover": not capped and current == "crush" and xp >= LOVER_XP_THRESHOLD and flirt_count >= FLIRT_REQUIREMENT,
        "soulmate": not capped and current == "lover" and xp >= SOULMATE_XP_THRESHOLD,
        "sibling": not capped and xp >= SPECIAL_XP,
        "family": not capped and xp >= SPECIAL_XP,
    }


def derive_bond(from_bond: str | None, xp: int, flirt_count: int, approvals: dict[str, bool] | None = None) -> BondDerivation:
    current = from_bond if is_bond(from_bond) else "stranger"
    approvals = approvals or {}
    capped = is_capped_bond(current)
    if approvals.get("family") and xp >= SPECIAL_XP:
        return BondDerivation("family", xp, f"family accepted (xp {xp})", current != "family", ["family"])
    if approvals.get("sibling") and xp >= SPECIAL_XP:
        return BondDerivation("sibling", xp, f"sibling accepted (xp {xp})", current != "sibling", ["sibling"])
    if not capped:
        if approvals.get("soulmate") and current == "lover" and xp >= SOULMATE_XP_THRESHOLD:
            return BondDerivation("soulmate", xp, f"marriage accepted while lover (xp {xp})", True, ["soulmate"])
        if approvals.get("soulmate") and current == "crush" and xp >= LOVER_XP_THRESHOLD:
            return BondDerivation("lover", xp, f"marriage accepted while crush — grants lover first, soulmate stays pending (xp {xp})", True, [])
        if approvals.get("lover") and current == "crush" and xp >= LOVER_XP_THRESHOLD and flirt_count >= FLIRT_REQUIREMENT:
            return BondDerivation("lover", xp, f"lover proposal accepted while crush (xp {xp}, flirts {flirt_count})", True, ["lover"])
    pending = [name for name in APPROVAL_NAMES if approvals.get(name) and BOND_LEVELS[current]["level"] < BOND_LEVELS[name]["level"]]
    if xp <= -150:
        return BondDerivation("enemy", xp, f"xp {xp} <= -150", current != "enemy", [])
    if current == "enemy":
        return BondDerivation("friend", xp, "recovered from enemy — jumps to friend", True, [])
    by_xp = bond_for_xp(xp)
    rank, keep = BOND_LEVELS[by_xp]["level"], BOND_LEVELS[current]["level"]
    bond, reason = current, f"xp {xp} supports level {rank}, keeping {current}"
    if rank > keep:
        bond, reason = by_xp, f"xp {xp} reached level {rank}"
    elif rank < keep and keep <= 3:
        if rank == 0:
            bond, reason = "friend", "xp %s is below the friend band, but stranger is not a fallback" % xp
        else:
            bond, reason = by_xp, f"xp {xp} fell back to level {rank}"
    if capped and BOND_LEVELS[bond]["level"] < 4:
        bond, reason = "close_friend", reason + " — capped rung cannot climb"
    if bond == "close_friend" and BOND_LEVELS[current]["level"] < 4:
        if xp >= CRUSH_XP_THRESHOLD and flirt_count >= FLIRT_REQUIREMENT:
            bond, reason = "crush", f"xp {xp} + {flirt_count} accepted flirts (xp >= {CRUSH_XP_THRESHOLD}, flirts >= {FLIRT_REQUIREMENT})"
        elif xp >= CRUSH_XP_THRESHOLD:
            reason = f"xp {xp} reaches crush but only {flirt_count}/{FLIRT_REQUIREMENT} flirts"
        else:
            reason = f"xp {xp} is below crush threshold {CRUSH_XP_THRESHOLD}"
    if pending:
        reason += " — pending: " + ", ".join(pending)
    return BondDerivation(bond, xp, reason, bond != current, [])


def bond_description(bond: str | None) -> str:
    if not bond:
        return "ไม่มีข้อมูลความสัมพันธ์"
    return f"{bond_label(bond)} ({bond}, ระดับ {bond_level(bond)})"
