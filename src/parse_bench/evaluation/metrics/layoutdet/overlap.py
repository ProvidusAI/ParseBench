"""Rendered layout overlap with a vectorized path for upright boxes."""

from collections.abc import Sequence

import numpy as np

from parse_bench.evaluation.metrics.layoutdet.iou import (
    compute_ioa_matrix,
    compute_iou_matrix,
    compute_rotated_ioa_matrix,
    compute_rotated_iou_matrix,
)


def compute_layout_iou(
    gt_boxes: np.ndarray,
    pred_boxes: np.ndarray,
    gt_angles: list[float | None],
    pred_angles: list[float | None],
    *,
    page_width: float = 1.0,
    page_height: float = 1.0,
    page_widths: Sequence[float] | None = None,
    page_heights: Sequence[float] | None = None,
) -> np.ndarray:
    """Return GT-by-prediction IoU, respecting rotation on either side."""
    if not any((angle or 0) % 360 for angle in gt_angles + pred_angles):
        return compute_iou_matrix(gt_boxes, pred_boxes)
    return compute_rotated_iou_matrix(
        gt_boxes,
        pred_boxes,
        gt_angles,
        pred_angles,
        page_width=page_width,
        page_height=page_height,
        page_widths=page_widths,
        page_heights=page_heights,
        force_rotated=True,
    )


def compute_layout_overlaps(
    gt_boxes: np.ndarray,
    pred_boxes: np.ndarray,
    gt_angles: list[float | None],
    pred_angles: list[float | None],
    *,
    page_width: float,
    page_height: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return IoU, GT-normalized IoA, and prediction-normalized IoA for one page.

    The first two matrices have shape (GT, predictions); the third is transposed.
    """
    iou = compute_layout_iou(
        gt_boxes,
        pred_boxes,
        gt_angles,
        pred_angles,
        page_width=page_width,
        page_height=page_height,
    )
    if not any((angle or 0) % 360 for angle in gt_angles + pred_angles):
        return iou, compute_ioa_matrix(gt_boxes, pred_boxes), compute_ioa_matrix(pred_boxes, gt_boxes)
    return (
        iou,
        compute_rotated_ioa_matrix(
            gt_boxes,
            pred_boxes,
            gt_angles,
            pred_angles,
            page_width=page_width,
            page_height=page_height,
        ),
        compute_rotated_ioa_matrix(
            pred_boxes,
            gt_boxes,
            pred_angles,
            gt_angles,
            page_width=page_width,
            page_height=page_height,
        ),
    )
