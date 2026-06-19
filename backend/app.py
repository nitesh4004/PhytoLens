import os
import re
import uuid
import shutil
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from backend.pc_handler import (
    search_stac,
    get_catalog,
    read_aligned_bands,
    calculate_index,
    calculate_roi_stats,
    get_color_palette,
    save_visual_png,
    save_geotiff,
    extract_geojson_geometries,
    fetch_lulc_raster,
    get_lulc_legend,
    colorize_lulc_png,
    compute_lulc_stats
)

app = FastAPI(title="PhytoLens API", description="Microsoft Planetary Computer Remote Sensing Analytics Engine")

# CORS middleware to allow React app requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static directory for serving generated images and exports
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(STATIC_DIR, exist_ok=True)

class SearchRequest(BaseModel):
    platform: str
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    start_date: str
    end_date: str
    cloud_cover: Optional[float] = 10.0
    orbit: Optional[str] = "BOTH"

class CalculateRequest(BaseModel):
    platform: str
    item_id: str
    bbox: List[float]
    index: str
    formula: Optional[str] = None
    palette: str
    vis_min: Optional[float] = None
    vis_max: Optional[float] = None
    geometry: Optional[Dict[str, Any]] = None

class TimeSeriesRequest(BaseModel):
    platform: str
    bbox: List[float]
    start_date: str
    end_date: str
    index: str
    formula: Optional[str] = None
    cloud_cover: Optional[float] = 10.0
    geometry: Optional[Dict[str, Any]] = None
    max_scenes: Optional[int] = 15

class LulcRequest(BaseModel):
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    dataset: str       # "esa-worldcover" or "io-lulc"
    year: int
    geometry: Optional[Dict[str, Any]] = None

def clean_old_static_files():
    """Keep static folder size small by cleaning files if there are too many."""
    try:
        files = [os.path.join(STATIC_DIR, f) for f in os.listdir(STATIC_DIR)]
        if len(files) > 50:
            # Sort by creation time
            files.sort(key=os.path.getmtime)
            # Remove oldest 20 files
            for f in files[:20]:
                if os.path.isfile(f):
                    os.remove(f)
    except Exception:
        pass

def get_band_mapping_and_collection(platform: str, index: str, formula: Optional[str] = None):
    """
    Helper to resolve band mapping, STAC collection name, and target resolution.
    """
    band_mapping = {}
    collection = ""
    target_res = 10
    
    if platform == "Sentinel-2 (Optical)":
        collection = "sentinel-2-l2a"
        if index == "NDVI":
            band_mapping = {"B4": "B04", "B8": "B08"}
        elif index == "GNDVI":
            band_mapping = {"B3": "B03", "B8": "B08"}
        elif index == "NDWI (Water)":
            band_mapping = {"B3": "B03", "B8": "B08"}
        elif index == "NDMI":
            band_mapping = {"B8": "B08", "B11": "B11"}
        elif index == "🛠️ Custom (Band Math)":
            # Extract all Bxx from custom formula
            bands_in_formula = list(set(re.findall(r'\bB[0-9]+[A-Z]?\b', formula or "")))
            band_mapping = {b: b if len(b) > 2 and b[1] == '0' else f"B{int(b[1:]):02d}" for b in bands_in_formula}
            # Add B8A handling
            for b in bands_in_formula:
                if b == "B8A":
                    band_mapping["B8A"] = "B8A"
        else:
            raise HTTPException(status_code=400, detail="Invalid index selection for Sentinel-2.")
            
    elif "Landsat" in platform:
        collection = "landsat-c2-l2"
        target_res = 30
        if index == "NDVI":
            band_mapping = {"B4": "red", "B5": "nir08"}
        elif index == "GNDVI":
            band_mapping = {"B3": "green", "B5": "nir08"}
        elif index == "NDWI (Water)":
            band_mapping = {"B3": "green", "B5": "nir08"}
        elif index == "NDMI":
            band_mapping = {"B5": "nir08", "B6": "swir16"}
        elif index == "LST (Thermal)":
            band_mapping = {"ST_B10": "lwir11"}
        elif index == "🛠️ Custom (Band Math)":
            # Map B1..B7 to Landsat band names
            landsat_map = {
                "B1": "coastal", "B2": "blue", "B3": "green", "B4": "red",
                "B5": "nir08", "B6": "swir16", "B7": "swir22"
            }
            bands_in_formula = list(set(re.findall(r'\bB[1-7]\b', formula or "")))
            band_mapping = {b: landsat_map[b] for b in bands_in_formula if b in landsat_map}
        else:
            raise HTTPException(status_code=400, detail="Invalid index selection for Landsat.")
            
    elif platform == "Sentinel-1 (Radar)":
        collection = "sentinel-1-grd"
        if index == "VV":
            band_mapping = {"VV": "vv"}
        elif index == "VH":
            band_mapping = {"VH": "vh"}
        elif index == "VH/VV Ratio":
            band_mapping = {"VV": "vv", "VH": "vh"}
        elif index == "🛠️ Custom (Band Math)":
            band_mapping = {"VV": "vv", "VH": "vh"}
        else:
            raise HTTPException(status_code=400, detail="Invalid polarization selection for Sentinel-1.")
            
    else:
        raise HTTPException(status_code=400, detail="Invalid platform selection.")
        
    return band_mapping, collection, target_res

@app.get("/api/health")
def health():
    return {"status": "online", "engine": "Planetary Computer"}

@app.post("/api/search")
def search_scenes(req: SearchRequest):
    collection = ""
    if "Sentinel-2" in req.platform:
        collection = "sentinel-2-l2a"
    elif "Landsat" in req.platform:
        collection = "landsat-c2-l2"
    elif "Sentinel-1" in req.platform:
        collection = "sentinel-1-grd"
    else:
        raise HTTPException(status_code=400, detail="Invalid satellite platform selection.")
        
    date_range = f"{req.start_date}/{req.end_date}"
    
    try:
        results, items = search_stac(
            collection=collection,
            bbox=req.bbox,
            date_range=date_range,
            cloud_cover=req.cloud_cover,
            orbit=req.orbit
        )
        
        # Filter Landsat 8/9 items specifically by platform identifier if needed
        if "Landsat 9" in req.platform:
            results = [r for r in results if "landsat-9" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-9"]
        elif "Landsat 8" in req.platform:
            results = [r for r in results if "landsat-8" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-8"]
            
        return {
            "count": len(results),
            "scenes": results[:50]  # Return top 50 scenes
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STAC search error: {str(e)}")

@app.post("/api/spectral/calculate")
def calculate_spectral_index(req: CalculateRequest):
    clean_old_static_files()
    
    try:
        band_mapping, collection, target_res = get_band_mapping_and_collection(
            req.platform, req.index, req.formula
        )
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        # 2. Get item
        catalog = get_catalog()
        item = catalog.get_collection(collection).get_item(req.item_id)
        if not item:
            raise HTTPException(status_code=404, detail=f"Scene {req.item_id} not found in collection {collection}.")
            
        # 3. Fetch & Align Bands
        bands_data, transform, crs = read_aligned_bands(
            item=item,
            bbox_wgs84=req.bbox,
            band_mapping=band_mapping,
            target_resolution=target_res
        )
        
        # Check if we successfully read data
        if not bands_data:
            raise HTTPException(status_code=500, detail="Could not retrieve any raster bands from STAC. The area or scene selection might be invalid.")

        # 4. Compute index
        index_array = calculate_index(bands_data, req.platform, req.index, req.formula)
        
        # Apply geometry mask if geometry is provided
        if req.geometry:
            from rasterio.features import geometry_mask
            geoms = extract_geojson_geometries(req.geometry)
            if geoms:
                mask = geometry_mask(geoms, out_shape=index_array.shape, transform=transform, invert=False)
                index_array[mask] = np.nan
        
        # 5. Stats & Visual stretch
        stats = calculate_roi_stats(index_array)
        
        vmin = req.vis_min if req.vis_min is not None else stats["p2"]
        vmax = req.vis_max if req.vis_max is not None else stats["p98"]
        
        # Calculate index-specific density bins for visual HUD donut charts
        density_bins = None
        valid = index_array[~np.isnan(index_array) & ~np.isinf(index_array)]
        if len(valid) > 0:
            total = len(valid)
            if req.index in ["NDVI", "GNDVI"]:
                high_count = np.sum(valid >= 0.6)
                mod_count = np.sum((valid >= 0.2) & (valid < 0.6))
                low_count = np.sum((valid >= 0.0) & (valid < 0.2))
                bare_count = np.sum(valid < 0.0)
                density_bins = {
                    "high": int(round((high_count / total) * 100)),
                    "moderate": int(round((mod_count / total) * 100)),
                    "low": int(round((low_count / total) * 100)),
                    "bare": int(round((bare_count / total) * 100))
                }
            elif "NDWI" in req.index:
                water_count = np.sum(valid >= 0.2)
                land_count = np.sum(valid < 0.2)
                density_bins = {
                    "water": int(round((water_count / total) * 100)),
                    "land": int(round((land_count / total) * 100))
                }
            elif "LST" in req.index:
                hot_count = np.sum(valid >= 35)
                warm_count = np.sum((valid >= 25) & (valid < 35))
                mild_count = np.sum((valid >= 15) & (valid < 25))
                cool_count = np.sum(valid < 15)
                density_bins = {
                    "hot": int(round((hot_count / total) * 100)),
                    "warm": int(round((warm_count / total) * 100)),
                    "mild": int(round((mild_count / total) * 100)),
                    "cool": int(round((cool_count / total) * 100))
                }
            else:
                # Default: split index range into 4 equal bins
                min_val = np.min(valid)
                max_val = np.max(valid)
                r = max_val - min_val if max_val > min_val else 1.0
                bin1 = np.sum(valid < min_val + 0.25*r)
                bin2 = np.sum((valid >= min_val + 0.25*r) & (valid < min_val + 0.5*r))
                bin3 = np.sum((valid >= min_val + 0.5*r) & (valid < min_val + 0.75*r))
                bin4 = np.sum(valid >= min_val + 0.75*r)
                density_bins = {
                    "bin1": int(round((bin1 / total) * 100)),
                    "bin2": int(round((bin2 / total) * 100)),
                    "bin3": int(round((bin3 / total) * 100)),
                    "bin4": int(round((bin4 / total) * 100))
                }
        
        # 6. Save visual PNG and raw GeoTIFF
        req_id = str(uuid.uuid4())
        png_filename = f"{req_id}_visual.png"
        tiff_filename = f"{req_id}_raw.tif"
        
        png_path = os.path.join(STATIC_DIR, png_filename)
        tiff_path = os.path.join(STATIC_DIR, tiff_filename)
        
        palette_colors = get_color_palette(req.palette)
        save_visual_png(index_array, vmin, vmax, palette_colors, png_path)
        save_geotiff(index_array, transform, crs, tiff_path)
        
        return {
            "req_id": req_id,
            "image_url": f"/api/static/{png_filename}",
            "geotiff_url": f"/api/static/{tiff_filename}",
            "stats": stats,
            "vis_min": vmin,
            "vis_max": vmax,
            "density_bins": density_bins
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calculation error: {str(e)}")

@app.post("/api/spectral/time-series")
def calculate_time_series(req: TimeSeriesRequest):
    """
    Calculate statistics for a remote sensing index over multiple scenes in a seasonal date range.
    """
    try:
        band_mapping, collection, target_res = get_band_mapping_and_collection(
            req.platform, req.index, req.formula
        )
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    date_range = f"{req.start_date}/{req.end_date}"
    
    try:
        results, items = search_stac(
            collection=collection,
            bbox=req.bbox,
            date_range=date_range,
            cloud_cover=req.cloud_cover,
            orbit="BOTH",
            limit=100
        )
        
        # Filter Landsat 8/9 items specifically by platform identifier if needed
        if "Landsat 9" in req.platform:
            results = [r for r in results if "landsat-9" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-9"]
            items = [item for item in items if "landsat-9" in item.id.lower() or item.properties.get("platform", "").lower() == "landsat-9"]
        elif "Landsat 8" in req.platform:
            results = [r for r in results if "landsat-8" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-8"]
            items = [item for item in items if "landsat-8" in item.id.lower() or item.properties.get("platform", "").lower() == "landsat-8"]
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STAC search error: {str(e)}")

    if not results:
        return {
            "timeseries": [],
            "index": req.index,
            "platform": req.platform
        }

    # Sort results chronologically (ascending date)
    results.sort(key=lambda x: x["date"])
    
    # Map item ID to Item object to keep them aligned
    item_map = {item.id: item for item in items}
    
    # Limit to max_scenes, subsampling evenly if count exceeds max_scenes
    max_s = req.max_scenes or 15
    if len(results) > max_s:
        indices = np.linspace(0, len(results) - 1, max_s, dtype=int)
        results = [results[i] for i in indices]
        
    timeseries_data = []
    catalog = get_catalog()
    
    for scene in results:
        scene_id = scene["id"]
        date_str = scene["date"]
        cc = scene["cloud_cover"]
        
        item = item_map.get(scene_id)
        if not item:
            try:
                item = catalog.get_collection(collection).get_item(scene_id)
            except Exception:
                continue
                
        if not item:
            continue
            
        try:
            # Fetch & Align Bands
            bands_data, transform, crs = read_aligned_bands(
                item=item,
                bbox_wgs84=req.bbox,
                band_mapping=band_mapping,
                target_resolution=target_res
            )
            
            if not bands_data:
                continue

            # Compute index
            index_array = calculate_index(bands_data, req.platform, req.index, req.formula)
            
            # Apply geometry mask if geometry is provided
            if req.geometry:
                from rasterio.features import geometry_mask
                geoms = extract_geojson_geometries(req.geometry)
                if geoms:
                    mask = geometry_mask(geoms, out_shape=index_array.shape, transform=transform, invert=False)
                    index_array[mask] = np.nan
            
            # Compute stats
            stats = calculate_roi_stats(index_array)
            
            if np.isnan(stats["mean"]):
                continue
                
            timeseries_data.append({
                "date": date_str,
                "scene_id": scene_id,
                "mean": float(stats["mean"]),
                "min": float(stats["min"]),
                "max": float(stats["max"]),
                "std": float(stats["std"]),
                "cloud_cover": float(cc) if cc is not None else 0.0
            })
        except Exception as e:
            # Resiliently skip corrupt/partial scenes
            print(f"Skipping scene {scene_id} due to calculation error: {e}")
            continue
            
    return {
        "timeseries": timeseries_data,
        "index": req.index,
        "platform": req.platform
    }


@app.post("/api/lulc/calculate")
def calculate_lulc(req: LulcRequest):
    """
    Fetch and classify a Land Use / Land Cover raster from Planetary Computer.
    Supports ESA WorldCover (2020-2021) and IO LULC Annual v02 (2017-2023).
    """
    clean_old_static_files()

    try:
        # 1. Fetch & reproject the LULC raster
        class_array, transform, crs = fetch_lulc_raster(
            bbox_wgs84=req.bbox,
            dataset=req.dataset,
            year=req.year
        )

        # 2. Apply geometry mask if provided
        if req.geometry:
            from rasterio.features import geometry_mask
            geoms = extract_geojson_geometries(req.geometry)
            if geoms:
                mask = geometry_mask(geoms, out_shape=class_array.shape, transform=transform, invert=False)
                class_array[mask] = 0  # Set masked pixels to nodata

        # 3. Get legend and compute stats
        legend = get_lulc_legend(req.dataset)

        # Approximate pixel area in m² based on bbox and grid dimensions
        h, w = class_array.shape
        lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
        # Approximate meters per degree at this latitude
        m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
        m_per_deg_lat = 110540
        pixel_w_m = ((req.bbox[2] - req.bbox[0]) / w) * m_per_deg_lon
        pixel_h_m = ((req.bbox[3] - req.bbox[1]) / h) * m_per_deg_lat
        pixel_area_m2 = pixel_w_m * pixel_h_m

        stats = compute_lulc_stats(class_array, legend, pixel_area_m2)

        # 4. Colorize and save PNG
        req_id = str(uuid.uuid4())
        png_filename = f"{req_id}_lulc.png"
        png_path = os.path.join(STATIC_DIR, png_filename)
        colorize_lulc_png(class_array, legend, png_path)

        # Build legend info for frontend
        legend_info = {}
        for class_val, info in legend.items():
            legend_info[str(class_val)] = {
                "name": info["name"],
                "color": info["color"]
            }

        return {
            "req_id": req_id,
            "image_url": f"/api/static/{png_filename}",
            "stats": stats,
            "legend": legend_info,
            "bbox": req.bbox,
            "year": req.year,
            "dataset": req.dataset
        }

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LULC calculation error: {str(e)}")


@app.get("/api/static/{filename}")
def serve_static(filename: str):
    file_path = os.path.join(STATIC_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")
