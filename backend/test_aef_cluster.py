import requests
import json

url = "http://127.0.0.1:8000/api/aef/cluster"
payload = {
    "bbox": [78.90, 20.50, 79.05, 20.65],
    "year": 2024,
    "num_clusters": 5
}

print("Sending POST request to /api/aef/cluster...")
try:
    res = requests.post(url, json=payload, timeout=60)
    print("Response status:", res.status_code)
    if res.status_code == 200:
        data = res.json()
        print("Success! Fields returned:")
        print(f"  req_id: {data.get('req_id')}")
        print(f"  image_url: {data.get('image_url')}")
        print(f"  geotiff_url: {data.get('geotiff_url')}")
        print(f"  num_clusters: {data.get('num_clusters')}")
        print("  stats keys:", list(data.get("stats", {}).keys()))
        print("  legend:", json.dumps(data.get("legend", {}), indent=2))
        
        # Verify fields
        assert "image_url" in data
        assert "geotiff_url" in data
        assert "stats" in data
        assert "legend" in data
        print("✅ Backend verification test passed successfully!")
    else:
        print("Error response:", res.text)
except Exception as e:
    print("Failed to connect or verify:", e)
