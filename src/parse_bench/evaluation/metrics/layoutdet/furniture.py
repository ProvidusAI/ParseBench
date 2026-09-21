"""Shared page-header/footer grouping and rendered-band coverage."""

from collections import Counter
from dataclasses import dataclass, field

import numpy as np

from parse_bench.evaluation.metrics.attribution.constants import LOCALIZATION_IOA_PRED_THRESHOLD
from parse_bench.evaluation.metrics.layoutdet.iou import convex_polygon_intersection, xyxy_to_rotated_polygon


@dataclass
class PageFurnitureGroup:
    pred_indices: list[int]
    clipped_boxes: list[list[float]]
    representative_pred_idx: int | None
    earliest_order_index: int | None
    x_span_coverage: float = 0.0
    x_fill_coverage: float = 0.0
    y_coverage: float = 0.0
    label_histogram: dict[str, int] = field(default_factory=dict)


def _clip_box_to_box(box: list[float], boundary: list[float]) -> list[float] | None:
    """Return the clipped intersection box, or None when there is no overlap."""
    x1 = max(box[0], boundary[0])
    y1 = max(box[1], boundary[1])
    x2 = min(box[2], boundary[2])
    y2 = min(box[3], boundary[3])
    if x2 <= x1 or y2 <= y1:
        return None
    return [x1, y1, x2, y2]


def _interval_union_length(intervals: list[tuple[float, float]]) -> float:
    """Return the total covered length of 1D intervals."""
    merged = sorted((start, end) for start, end in intervals if end > start)
    if not merged:
        return 0.0

    total = 0.0
    curr_start, curr_end = merged[0]
    for start, end in merged[1:]:
        if start <= curr_end:
            curr_end = max(curr_end, end)
            continue
        total += curr_end - curr_start
        curr_start, curr_end = start, end
    total += curr_end - curr_start
    return total


def _compute_page_furniture_band_coverage(
    gt_box: list[float],
    clipped_boxes: list[list[float]],
) -> tuple[float, float, float]:
    """Return normalized horizontal and vertical recovery of a GT furniture band."""
    gt_width = max(gt_box[2] - gt_box[0], 0.0)
    gt_height = max(gt_box[3] - gt_box[1], 0.0)
    if gt_width <= 0.0 or gt_height <= 0.0 or not clipped_boxes:
        return 0.0, 0.0, 0.0

    x_span_coverage = (max(box[2] for box in clipped_boxes) - min(box[0] for box in clipped_boxes)) / gt_width
    x_fill_coverage = _interval_union_length([(box[0], box[2]) for box in clipped_boxes]) / gt_width
    y_coverage = _interval_union_length([(box[1], box[3]) for box in clipped_boxes]) / gt_height
    return min(x_span_coverage, 1.0), min(x_fill_coverage, 1.0), min(y_coverage, 1.0)


def build_page_furniture_group(
    *,
    gt_box: list[float],
    gt_idx: int,
    pred_boxes: list[list[float]],
    ioa_pred_to_gt: np.ndarray | None,
    iou_row: np.ndarray | None = None,
    pred_order_indices: list[int] | None = None,
    pred_classes: list[str | None] | None = None,
    gt_angle: float | None = None,
    pred_angles: list[float | None] | None = None,
    page_width: float = 1.0,
    page_height: float = 1.0,
) -> PageFurnitureGroup:
    """Group predictions that recover a page-header/footer GT band."""
    if ioa_pred_to_gt is None or not pred_boxes:
        return PageFurnitureGroup([], [], None, None)

    candidate_indices = [
        int(pred_idx) for pred_idx in np.where(ioa_pred_to_gt[:, gt_idx] >= LOCALIZATION_IOA_PRED_THRESHOLD)[0]
    ]

    rotated = any((angle or 0) % 360 for angle in [gt_angle] + (pred_angles or []))
    if rotated:
        dimensions = {"page_width": page_width, "page_height": page_height}
        gt_polygon = xyxy_to_rotated_polygon(gt_box, gt_angle or 0, **dimensions)
        physical_gt = np.array(gt_polygon) * [page_width, page_height]
        axes = physical_gt[[1, 3]] - physical_gt[0]
        squared_lengths = np.sum(axes * axes, axis=1)
        if np.any(squared_lengths == 0):
            return PageFurnitureGroup([], [], None, None)

    retained_indices: list[int] = []
    clipped_boxes: list[list[float]] = []
    for pred_idx in candidate_indices:
        if rotated:
            polygon = xyxy_to_rotated_polygon(
                pred_boxes[pred_idx], (pred_angles[pred_idx] or 0) if pred_angles else 0, **dimensions
            )
            intersection = convex_polygon_intersection(polygon, gt_polygon)
            if not intersection:
                continue
            # Measure polygon projections in the GT band's own physical frame.
            points = (np.array(intersection) * [page_width, page_height] - physical_gt[0]) @ axes.T / squared_lengths
            clipped = [*points.min(axis=0), *points.max(axis=0)]
        else:
            clipped = _clip_box_to_box(pred_boxes[pred_idx], gt_box)
        if clipped is None:
            continue
        retained_indices.append(pred_idx)
        clipped_boxes.append(clipped)

    if not retained_indices:
        return PageFurnitureGroup([], [], None, None)

    representative_pred_idx = retained_indices[0]
    if iou_row is not None:
        representative_pred_idx = int(retained_indices[np.argmax(iou_row[retained_indices])])

    if pred_order_indices is None:
        earliest_order_index = min(retained_indices)
    else:
        earliest_order_index = min(pred_order_indices[pred_idx] for pred_idx in retained_indices)

    label_histogram: dict[str, int] = {}
    if pred_classes is not None:
        label_histogram = dict(
            Counter(str(pred_classes[pred_idx]) for pred_idx in retained_indices if pred_classes[pred_idx] is not None)
        )

    x_span_coverage, x_fill_coverage, y_coverage = _compute_page_furniture_band_coverage(
        [0, 0, 1, 1] if rotated else gt_box, clipped_boxes
    )
    return PageFurnitureGroup(
        pred_indices=retained_indices,
        clipped_boxes=clipped_boxes,
        representative_pred_idx=representative_pred_idx,
        earliest_order_index=earliest_order_index,
        x_span_coverage=x_span_coverage,
        x_fill_coverage=x_fill_coverage,
        y_coverage=y_coverage,
        label_histogram=label_histogram,
    )
