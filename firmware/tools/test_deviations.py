"""firmware/DEVIATIONS.md and emulator/DEVIATIONS.md list exactly the files in deviations/ (issue eink-ha-os#117)."""
import os
import unittest

import deviations


class IndexTest(unittest.TestCase):
    def test_index_current(self):
        for top in deviations.DIRS:
            _, old, new = deviations.render(top)
            self.assertEqual(old, new, f'{top}/DEVIATIONS.md is stale: run `make deviations`')

    def test_title(self):
        d = os.path.join(deviations.ROOT, 'emulator', 'deviations')
        self.assertEqual(deviations.title(os.path.join(d, '010-power-saving.md')), '10. Power saving and deep sleep')
        self.assertEqual(deviations.title(os.path.join(d, '031-improv-serial.md')), 'Improv Wi-Fi serial (issue #31)')


if __name__ == '__main__':
    unittest.main()
