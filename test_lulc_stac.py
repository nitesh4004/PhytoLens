"""Quick test to debug LULC STAC search issues."""
import pystac_client
import planetary_computer

STAC_API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

catalog = pystac_client.Client.open(STAC_API_URL, modifier=planetary_computer.sign_inplace)

bbox = [78.900000, 20.500000, 79.050000, 20.650000]

# Test 1: ESA WorldCover
print("=== ESA WorldCover ===")
try:
    search = catalog.search(
        collections=["esa-worldcover"],
        bbox=bbox,
        datetime="2021-01-01/2021-12-31",
        limit=10
    )
    items = search.item_collection()
    print(f"Found {len(items)} items")
    for item in items:
        print(f"  Item ID: {item.id}")
        print(f"  Assets: {list(item.assets.keys())}")
except Exception as e:
    print(f"ERROR: {e}")

print()

# Test 2: IO LULC Annual v02
print("=== IO LULC Annual v02 ===")
try:
    search = catalog.search(
        collections=["io-lulc-annual-v02"],
        bbox=bbox,
        datetime="2022-01-01/2022-12-31",
        limit=10
    )
    items = search.item_collection()
    print(f"Found {len(items)} items")
    for item in items:
        print(f"  Item ID: {item.id}")
        print(f"  Assets: {list(item.assets.keys())}")
except Exception as e:
    print(f"ERROR: {e}")

print()

# Test 3: Try without datetime for ESA WorldCover
print("=== ESA WorldCover (no datetime filter) ===")
try:
    search = catalog.search(
        collections=["esa-worldcover"],
        bbox=bbox,
        limit=10
    )
    items = search.item_collection()
    print(f"Found {len(items)} items")
    for item in items:
        print(f"  Item ID: {item.id}")
        print(f"  Datetime: {item.properties.get('datetime', 'N/A')}")
        print(f"  Assets: {list(item.assets.keys())}")
except Exception as e:
    print(f"ERROR: {e}")

print()

# Test 4: Try IO LULC without datetime
print("=== IO LULC Annual v02 (no datetime filter) ===")
try:
    search = catalog.search(
        collections=["io-lulc-annual-v02"],
        bbox=bbox,
        limit=10
    )
    items = search.item_collection()
    print(f"Found {len(items)} items")
    for item in items:
        print(f"  Item ID: {item.id}")
        print(f"  Datetime: {item.properties.get('datetime', 'N/A')}")
        print(f"  Start: {item.properties.get('start_datetime', 'N/A')}")
        print(f"  End: {item.properties.get('end_datetime', 'N/A')}")
        print(f"  Assets: {list(item.assets.keys())}")
except Exception as e:
    print(f"ERROR: {e}")
