"""Pydantic v2 schemas for position bookmark CRUD operations."""

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_serializer, field_validator, model_validator

from app.models.position_bookmark import PositionBookmark

Color = Literal["white", "black"]
BookmarkMatchSide = Literal["mine", "opponent", "both", "full"]


class PositionSuggestion(BaseModel):
    """A single position bookmark suggestion derived from most-played openings."""

    white_hash: str
    black_hash: str
    full_hash: str
    fen: str
    moves: list[str]
    color: Color
    game_count: int
    opening_name: str | None
    opening_eco: str | None

    @field_serializer("white_hash", "black_hash", "full_hash")
    def serialize_hash(self, v: int) -> str:
        return str(v)


class SuggestionsResponse(BaseModel):
    """Response schema for position bookmark suggestions."""

    suggestions: list[PositionSuggestion]


class MatchSideUpdateRequest(BaseModel):
    """Request body for updating match_side on an existing position bookmark."""

    match_side: Literal["mine", "opponent", "both"]


class PositionBookmarkCreate(BaseModel):
    """Request body for creating a position bookmark."""

    label: str
    target_hash: int  # JavaScript sends as decimal string; coerced by validator

    @field_validator("target_hash", mode="before")
    @classmethod
    def coerce_target_hash(cls, v: object) -> object:
        """Accept string target_hash from JavaScript frontend.

        JavaScript BigInt cannot be safely represented as a JSON number
        (IEEE-754 double loses precision for values > 2^53). The frontend
        sends the hash as a decimal string; this validator converts it to int.
        """
        if isinstance(v, str):
            return int(v)
        return v

    fen: str
    moves: list[str]
    color: Color | None = None
    match_side: BookmarkMatchSide = "full"
    is_flipped: bool = False


class PositionBookmarkUpdate(BaseModel):
    """Request body for updating a position bookmark (all fields optional)."""

    label: str | None = None
    sort_order: int | None = None


class PositionBookmarkReorderRequest(BaseModel):
    """Request body for bulk reorder: ordered list of position bookmark IDs."""

    ids: list[int]


class PositionBookmarkResponse(BaseModel):
    """Response schema for a single position bookmark."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    target_hash: str  # returned as string to avoid JS precision loss

    @field_serializer("target_hash")
    def serialize_target_hash(self, v: int) -> str:
        return str(v)

    fen: str
    moves: list[str]  # deserialized from JSON string stored in DB
    color: Color | None
    match_side: BookmarkMatchSide
    is_flipped: bool
    sort_order: int

    @model_validator(mode="before")
    @classmethod
    def deserialize_moves(cls, data: object) -> object:
        """Deserialize moves from JSON string (ORM) or pass through list (dict input)."""
        if isinstance(data, PositionBookmark):
            # ORM object — deserialize moves from JSON string
            raw = data.moves
            if isinstance(raw, str):
                # Return a dict-like object by extracting attributes
                return {
                    "id": data.id,
                    "label": data.label,
                    "target_hash": str(data.target_hash),
                    "fen": data.fen,
                    "moves": json.loads(raw),
                    "color": data.color,
                    "match_side": data.match_side,
                    "is_flipped": data.is_flipped,
                    "sort_order": data.sort_order,
                }
        if isinstance(data, dict) and "moves" in data:
            if isinstance(data["moves"], str):
                data = dict(data)
                data["moves"] = json.loads(data["moves"])
        return data
