import unittest

from aira.relationships import bond_for_xp, derive_bond, is_bond_unlock, relationship_permissions


class RelationshipTests(unittest.TestCase):
    def test_xp_bands(self):
        self.assertEqual(bond_for_xp(-150), "enemy")
        self.assertEqual(bond_for_xp(-149), "stranger")
        self.assertEqual(bond_for_xp(50), "acquaintance")
        self.assertEqual(bond_for_xp(150), "friend")
        self.assertEqual(bond_for_xp(300), "close_friend")

    def test_crush_requires_xp_and_five_flirts(self):
        self.assertEqual(derive_bond("close_friend", 500, 4).bond, "close_friend")
        self.assertEqual(derive_bond("close_friend", 500, 5).bond, "crush")

    def test_lover_and_soulmate_need_approval(self):
        self.assertEqual(derive_bond("crush", 700, 5).bond, "crush")
        self.assertEqual(derive_bond("crush", 700, 5, {"lover": True}).bond, "lover")
        self.assertEqual(derive_bond("lover", 1000, 5, {"soulmate": True}).bond, "soulmate")

    def test_special_bonds_are_capped(self):
        self.assertEqual(derive_bond("friend", 500, 5, {"sibling": True}).bond, "sibling")
        self.assertEqual(derive_bond("friend", 500, 5, {"family": True}).bond, "family")

    def test_permission_gate(self):
        permissions = relationship_permissions("crush", 700, 5)
        self.assertTrue(permissions["lover"])
        self.assertFalse(permissions["soulmate"])
        self.assertFalse(relationship_permissions("family", 1000, 10)["lover"])

    def test_unlock(self):
        self.assertTrue(is_bond_unlock("friend", "close_friend"))
        self.assertFalse(is_bond_unlock("lover", "crush"))


if __name__ == "__main__":
    unittest.main()
