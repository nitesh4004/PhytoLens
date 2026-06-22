import requests
import json

url = "http://127.0.0.1:8000/api/aef/similarity"
payload = {
    "bbox": [78.90, 20.50, 79.05, 20.65],
    "year": 2024,
    "query_geometry": {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [78.945, 20.545],
                [78.955, 20.545],
                [78.955, 20.555],
                [78.945, 20.555],
                [78.945, 20.545]
            ]]
        },
        "properties": {}
    },
    "threshold": 0.85
}

print("Sending POST request to /api/aef/similarity...")
try:
    res = requests.post(url, json=payload, timeout=60)
    print("Response status:", res.status_code)
    if res.status_code == 200:
        data = res.json()
        print("Success! Fields returned:")
        print(f"  req_id: {data.get('req_id')}")
        print(f"  image_url: {data.get('image_url')}")
        print(f"  geotiff_url: {data.get('geotiff_url')}")
        print(f"  threshold: {data.get('threshold')}")
        print("  stats keys:", list(data.get("stats", {}).keys()))
        print("  stats content:", json.dumps(data.get("stats", {}), indent=2))
        
        # Verify fields
        assert "image_url" in data
        assert "geotiff_url" in data
        assert "stats" in data
        assert "threshold" in data
        print("[SUCCESS] Backend similarity verification test passed successfully!")
    else:
        print("Error response:", res.text)
except Exception as e:
    print("Failed to connect or verify:", e)
