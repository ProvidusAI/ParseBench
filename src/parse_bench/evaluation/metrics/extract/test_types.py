"""Test type definitions for extract evaluation."""

from enum import StrEnum


class ExtractTestType(StrEnum):
    """Test types for extract evaluation."""

    ARRAY_LENGTH = "array_length"
    ARRAY_HEAD = "array_head"
    ARRAY_TAIL = "array_tail"
