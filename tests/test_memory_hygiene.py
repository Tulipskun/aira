import unittest

from aira import memory


class MemoryHygieneTests(unittest.TestCase):
    def test_boilerplate_about_being_available_is_rejected(self):
        for text in ("แจ้งให้คุณทราบว่าฉันอยู่ตรงนี้และพร้อมรับคำสั่งเกี่ยวกับภารกิจเสมอ",
                     "ฉันพร้อมให้บริการคุณเสมอค่ะ",
                     "Standing by for your orders"):
            self.assertFalse(memory.worth_remembering(text), text)

    def test_a_summary_of_who_answered_whom_is_not_a_memory(self):
        self.assertFalse(memory.worth_remembering(
            "เรมตอบกลับคุณยูตะเรื่องความร่ำรวยของเสี่ยฟาริสอย่างสุภาพ"))
        self.assertFalse(memory.worth_remembering(
            "โอริกามิตอบกลับข้อความของคุณยูตะว่าเธออยู่ที่นี่"))

    def test_a_real_fact_is_kept(self):
        self.assertTrue(memory.worth_remembering("คุณยูตะชอบดื่มชาเขียวตอนเช้า"))

    def test_a_reworded_copy_of_an_existing_memory_is_dropped(self):
        known = ["คุณยูตะชอบดื่มชาเขียวตอนเช้าทุกวัน"]
        self.assertFalse(memory.worth_remembering("คุณยูตะชอบดื่มชาเขียวตอนเช้าทุกวันจริง ๆ", known))

    def test_overlap_separates_a_repeat_from_a_new_line(self):
        said = "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST หรือเปล่าคะ"
        self.assertGreater(memory.overlap_ratio(said, "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST ไหมคะ"), 0.6)
        self.assertLess(memory.overlap_ratio(said, "วันนี้อากาศดีนะ"), 0.3)


if __name__ == "__main__":
    unittest.main()
