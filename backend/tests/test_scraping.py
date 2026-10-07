"""Pure helper functions used by price search."""
import pytest

import main


@pytest.mark.parametrize("text,expected", [
    ("$1,299.99", 1299.99),
    ("US $24.50", 24.5),
    ("$12.00 - $15.00", 12.0),     # ranges use the lower price
    ("$19.99/mo", None),           # monthly payment is not a price
    ("abc", None),
    ("", None),
])
def test_parse_price(text, expected):
    assert main._parse_price(text) == expected


def test_relevance_score_prefers_matching_titles():
    good = main._relevance_score("Logitech M185 Wireless Mouse", "wireless mouse")
    bad = main._relevance_score("Phone case", "wireless mouse")
    assert good > bad


def test_dedupe_removes_repeated_products():
    items = [
        {"source": "Amazon", "url": "https://amazon.com/dp/A1?ref=x", "title": "Mouse", "price": 10},
        {"source": "Amazon", "url": "https://amazon.com/dp/A1?ref=y", "title": "Mouse", "price": 10},  # same link
        {"source": "Amazon", "url": "https://amazon.com/dp/A2", "title": "Mouse", "price": 10},        # same title+price
        {"source": "eBay",   "url": "https://ebay.com/itm/1", "title": "Mouse", "price": 10},          # other shop
        {"source": "Amazon", "url": "https://amazon.com/dp/A3", "title": "Keyboard", "price": 20},
    ]
    out = main._dedupe_items(items)
    assert [(i["source"], i["url"]) for i in out] == [
        ("Amazon", "https://amazon.com/dp/A1?ref=x"),
        ("eBay", "https://ebay.com/itm/1"),
        ("Amazon", "https://amazon.com/dp/A3"),
    ]
