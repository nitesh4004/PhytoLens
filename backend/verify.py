import os
import sys
import numpy as np

# Add parent directory to path so we can import pc_handler
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.pc_handler import (
    search_stac,
    read_aligned_bands,
    calculate_index,
    calculate_roi_stats
)

def test_verify():
    print("🛰️ Starting Automated Verification of PhytoLens MPC Backend...")
    
    # ROI: Centered around a small region in Central India (Wardha/Nagpur area)
    bbox = [78.90, 20.50, 79.05, 20.65]
    print(f"Locked Target ROI: {bbox}")
    
    # 1. Test Sentinel-2 search and NDVI calculation
    print("\n--- 1. Testing Sentinel-2 Search & NDVI ---")
    s2_results, s2_items = search_stac(
        collection="sentinel-2-l2a",
        bbox=bbox,
        date_range="2024-01-01/2024-02-15",
        cloud_cover=10.0
    )
    print(f"Found {len(s2_results)} Sentinel-2 scenes.")
    if len(s2_items) > 0:
        item = s2_items[0]
        print(f"Selected latest scene: {item.id} (Date: {s2_results[0]['date']})")
        
        # Read B4 (Red) and B8 (NIR)
        print("Reading S2 band assets...")
        band_mapping = {"B4": "B04", "B8": "B08"}
        bands_data, transform, crs = read_aligned_bands(
            item=item,
            bbox_wgs84=bbox,
            band_mapping=band_mapping,
            target_resolution=10
        )
        print(f"Bands read successfully. Grid shape: {bands_data['B4'].shape}")
        
        print("Calculating NDVI...")
        ndvi = calculate_index(bands_data, "Sentinel-2 (Optical)", "NDVI")
        stats = calculate_roi_stats(ndvi)
        print(f"NDVI calculated. Stats -> Min: {stats['min']:.3f}, Max: {stats['max']:.3f}, Mean: {stats['mean']:.3f}")
        assert stats["mean"] > -1.0 and stats["mean"] < 1.0, "NDVI out of bounds"
        print("✅ Sentinel-2 & NDVI calculation: SUCCESS")
    else:
        print("❌ No S2 scenes found.")
        sys.exit(1)
        
    print("\n🎉 AUTOMATED VERIFICATION: ALL PASSED!")

if __name__ == "__main__":
    test_verify()
