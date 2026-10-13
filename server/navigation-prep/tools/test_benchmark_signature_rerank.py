"""Hermetic metric checks: duplicate profiles, self identity, and integer truth."""
import unittest
import numpy as np
from benchmark_signature_rerank import distances_bytes, metrics, ordered_top, selected_cells, shortlist_transport


class RetrievalMetricsTest(unittest.TestCase):
    def test_excludes_self_by_identity_not_first_duplicate(self):
        ids = np.array([90, 10, 50, 20])
        self.assertEqual(ids[ordered_top(np.zeros(4), ids, 10, exclude=50)].tolist(), [10, 20, 90])

    def test_cutoff_ties_are_resolved_by_id(self):
        ids = np.array([40, 10, 30, 20])
        distance = np.array([1., 0., 1., 1.])
        self.assertEqual(ids[ordered_top(distance, ids, 2)].tolist(), [10, 20])

    def test_exact_byte_distance_even_at_opposite_corners(self):
        rows = np.array([[0] * 581, [255] * 581], dtype=np.uint8)
        got = distances_bytes(rows, rows)
        np.testing.assert_array_equal(got, [[0, 581 * 255 ** 2], [581 * 255 ** 2, 0]])

    def test_reports_equivalent_ties_without_claiming_identity_recall(self):
        ids = np.arange(31)
        exact = np.zeros(31)
        result = metrics(exact, ids, 0, np.arange(20, 30))
        self.assertEqual(result["recall10"], 0)
        self.assertEqual(result["tie_aware10"], 1)
        self.assertEqual(result["distance_ratio"], 1)

    def test_does_not_hide_missed_zero_distance_truth_in_ratio(self):
        ids = np.arange(31)
        exact = np.r_[np.zeros(11), np.ones(20)]
        result = metrics(exact, ids, 0, np.arange(20, 30))
        self.assertTrue(result["zero_truth_missed"])
        self.assertIsNone(result["distance_ratio"])
        self.assertEqual(result["tie_aware10"], 0)

    def test_transport_counts_reference_and_unique_shortlist_cells(self):
        cells = [{"end": 20, "segments": 10}, {"end": 60, "segments": 20}]
        got = shortlist_transport(cells, np.array([21, 22]), 1, [0, 1, 64, 65])
        self.assertEqual(got["annual_bytes_after_shortlist"], 30 * 2 * 4)
        self.assertEqual(got["annual_requests_after_shortlist"], 2 * 2)
        self.assertEqual(got["ideal_candidate_bytes"], 3 * 4)

    def test_handles_empty_selection_and_short_pools(self):
        self.assertEqual(selected_cells([], (-74, 40.7), 400), [])
        ids = np.arange(4)
        result = metrics(np.arange(4.), ids, 0, np.array([1, 2, 3]))
        self.assertEqual(result["k"], 3)
        self.assertEqual(result["recall10"], 1)


if __name__ == "__main__":
    unittest.main()
