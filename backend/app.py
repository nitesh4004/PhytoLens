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

app = FastAPI(title="PhytoLens API", description="Geospatial Tools for Crop Health")

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

class AefClusterRequest(BaseModel):
    bbox: List[float]
    year: int
    num_clusters: int
    geometry: Optional[Dict[str, Any]] = None

class AefSimilarityRequest(BaseModel):
    bbox: List[float]
    year: int
    query_geometry: Dict[str, Any]
    threshold: Optional[float] = None  # default chosen per mode below
    geometry: Optional[Dict[str, Any]] = None
    palette: Optional[str] = "Viridis (Sequential)"
    # "centered" = mean-centered cosine (default; resolves distinct features such
    # as water in homogeneous ROIs). "dotproduct" = raw dot product (Google's
    # literal method; best for diverse scenes / distinct rare targets).
    mode: Optional[str] = "centered"

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


@app.post("/api/aef/cluster")
def cluster_aef_embeddings(req: AefClusterRequest):
    clean_old_static_files()
    
    # 1. Resolve index path
    index_path = os.path.join(STATIC_DIR, "aef_index.parquet")
    workspace_index = os.path.join(os.path.dirname(BASE_DIR), "aef_index.parquet")
    if os.path.exists(workspace_index):
        index_path = workspace_index
    elif not os.path.exists(index_path):
        import requests
        print("Downloading aef_index.parquet...")
        url = "https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        try:
            res = requests.get(url, headers=headers, timeout=60)
            if res.status_code == 200:
                with open(index_path, "wb") as f:
                    f.write(res.content)
            else:
                raise HTTPException(status_code=500, detail=f"Failed to download AEF index: HTTP {res.status_code}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to retrieve AEF index: {str(e)}")

    # 2. Read parquet index
    import pandas as pd
    try:
        df = pd.read_parquet(index_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load AEF index: {str(e)}")

    # 3. Query overlapping tiles
    df_year = df[df["year"] == req.year]
    min_lon, min_lat, max_lon, max_lat = req.bbox
    
    overlapping = df_year[
        (df_year["wgs84_west"] <= max_lon) &
        (df_year["wgs84_east"] >= min_lon) &
        (df_year["wgs84_south"] <= max_lat) &
        (df_year["wgs84_north"] >= min_lat)
    ]
    
    if len(overlapping) == 0:
        raise HTTPException(
            status_code=404,
            detail=f"No AlphaEarth satellite embedding tiles found for year {req.year} in the selected area."
        )

    # 4. Define target grid in EPSG:4326
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    # Cap size to avoid OOM and long network transfer times
    width = max(10, min(width, 150))
    height = max(10, min(height, 150))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    # Prepare array to hold the 64 embedding bands
    bands_data = np.full((64, height, width), np.nan, dtype=np.float32)

    try:
        for _, row in overlapping.iterrows():
            s3_path = row["path"]
            http_path = s3_path.replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
            vsi_path = f"/vsicurl/{http_path}"
            
            with rasterio.open(vsi_path) as src:
                src_bbox = transform_bounds("EPSG:4326", src.crs, min_lon, min_lat, max_lon, max_lat)
                left, bottom, right, top = src_bbox
                
                row1, col1 = src.index(left, top)
                row2, col2 = src.index(right, bottom)
                
                row_start = max(0, min(row1, row2, src.height))
                row_end = max(0, min(max(row1, row2), src.height))
                col_start = max(0, min(col1, col2, src.width))
                col_end = max(0, min(max(col1, col2), src.width))
                
                if row_end > row_start and col_end > col_start:
                    from rasterio.windows import Window
                    from rasterio.transform import Affine
                    window = Window(col_start, row_start, col_end - col_start, row_end - row_start)
                    
                    # Decimated read to target shape
                    src_data = src.read(out_shape=(64, height, width), window=window, out_dtype=np.float32)
                    window_transform = rasterio.windows.transform(window, src.transform)
                    scale_x = window.width / width
                    scale_y = window.height / height
                    decimated_transform = window_transform * Affine.scale(scale_x, scale_y)
                    
                    for b in range(1, 65):
                        temp_dest = np.zeros(target_shape, dtype=np.float32)
                        reproject(
                            source=src_data[b-1],
                            destination=temp_dest,
                            src_transform=decimated_transform,
                            src_crs=src.crs,
                            dst_transform=target_transform,
                            dst_crs=target_crs,
                            resampling=Resampling.bilinear,
                            src_nodata=src.nodata,
                            dst_nodata=np.nan
                        )
                        mask = ~np.isnan(temp_dest)
                        bands_data[b-1, mask] = temp_dest[mask]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read satellite embeddings: {str(e)}")

    # Apply geometry mask if provided
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            mask = geometry_mask(geoms, out_shape=target_shape, transform=target_transform, invert=False)
            for b in range(64):
                bands_data[b, mask] = np.nan

    # 5. Unsupervised clustering
    valid_mask = ~np.isnan(bands_data).any(axis=0)
    valid_mask_flat = valid_mask.flatten()
    valid_pixels = bands_data.reshape(64, -1).T[valid_mask_flat]

    if len(valid_pixels) == 0:
        raise HTTPException(
            status_code=400,
            detail="The selected ROI contains no valid satellite embedding data. Try adjusting the bounding box."
        )

    # Perform KMeans
    from sklearn.cluster import KMeans
    try:
        kmeans = KMeans(n_clusters=req.num_clusters, random_state=42, n_init=10)
        cluster_labels = kmeans.fit_predict(valid_pixels)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clustering algorithm failure: {str(e)}")

    # Sort labels descending by pixel count
    unique_labels, counts = np.unique(cluster_labels, return_counts=True)
    sorted_indices = np.argsort(-counts)
    sorted_labels = unique_labels[sorted_indices]
    label_map = {old: new + 1 for new, old in enumerate(sorted_labels)}
    sorted_cluster_labels = np.array([label_map[l] for l in cluster_labels])

    # Reconstruct 2D classification map (0 is transparent background)
    class_map = np.zeros(height * width, dtype=np.uint8)
    class_map[valid_mask_flat] = sorted_cluster_labels
    class_map = class_map.reshape(height, width)

    # Define color scheme (10 distinct vibrant/harmonious colors)
    CLUSTER_COLORS = [
        "#3b82f6",  # Blue
        "#10b981",  # Green
        "#ef4444",  # Red
        "#f59e0b",  # Amber/Yellow
        "#8b5cf6",  # Purple
        "#ec4899",  # Pink
        "#14b8a6",  # Teal
        "#f97316",  # Orange
        "#6366f1",  # Indigo
        "#84cc16"   # Lime
    ]

    legend = {}
    for i in range(req.num_clusters):
        class_val = i + 1
        color = CLUSTER_COLORS[i % len(CLUSTER_COLORS)]
        legend[class_val] = {
            "name": f"Cluster {class_val}",
            "color": color
        }

    # 6. Save outputs
    req_id = str(uuid.uuid4())
    png_filename = f"{req_id}_aef_cluster.png"
    tiff_filename = f"{req_id}_aef_cluster.tif"
    
    png_path = os.path.join(STATIC_DIR, png_filename)
    tiff_path = os.path.join(STATIC_DIR, tiff_filename)

    colorize_lulc_png(class_map, legend, png_path)
    save_geotiff(class_map.astype(np.float32), target_transform, target_crs, tiff_path)

    # Calculate statistics
    lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((req.bbox[2] - req.bbox[0]) / width) * m_per_deg_lon
    pixel_h_m = ((req.bbox[3] - req.bbox[1]) / height) * m_per_deg_lat
    pixel_area_m2 = pixel_w_m * pixel_h_m

    stats = compute_lulc_stats(class_map, legend, pixel_area_m2)

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
        "geotiff_url": f"/api/static/{tiff_filename}",
        "stats": stats,
        "legend": legend_info,
        "bbox": req.bbox,
        "year": req.year,
        "num_clusters": req.num_clusters
    }

def sample_native_query_reference(overlapping, q_geoms):
    """
    Sample the query reference embedding at NATIVE ~10 m resolution.

    The main ROI grid is decimated (capped at 150x150), so a small distinct
    feature such as a water body becomes only a few pixels and its edges are
    blended toward the surrounding land. Averaging those blended pixels into the
    reference corrupts it and can rank the feature BELOW the background. Google's
    tutorial samples references at scale=10, so we mirror that: read the source
    COGs at full resolution over just the query polygon, keep valid pixels inside
    it using NEAREST resampling (no blending), then unit-normalize and average.
    Returns a (64,) reference vector, or None if no valid pixels are found.
    """
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    from rasterio.windows import Window
    from rasterio.features import geometry_mask

    # Bounds of the query geometry (recursively scan coordinate tuples).
    xs, ys = [], []
    def _walk(c):
        if isinstance(c, (list, tuple)):
            if len(c) >= 2 and isinstance(c[0], (int, float)) and isinstance(c[1], (int, float)):
                xs.append(c[0]); ys.append(c[1])
            else:
                for sub in c:
                    _walk(sub)
    for g in q_geoms:
        _walk(g.get("coordinates", []))
    if not xs:
        return None

    pad = 20.0 / 111000.0  # ~20 m padding around the polygon
    qminx, qminy = min(xs) - pad, min(ys) - pad
    qmaxx, qmaxy = max(xs) + pad, max(ys) + pad

    res = 10.0 / 111000.0
    qw = max(1, min(int(np.ceil((qmaxx - qminx) / res)), 256))
    qh = max(1, min(int(np.ceil((qmaxy - qminy) / res)), 256))
    qpw = (qmaxx - qminx) / qw
    qph = (qmaxy - qminy) / qh
    qtt = from_origin(qminx, qmaxy, qpw, qph)
    qshape = (qh, qw)

    qbands = np.full((64, qh, qw), np.nan, dtype=np.float32)
    for _, row in overlapping.iterrows():
        http_path = row["path"].replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
        vsi_path = f"/vsicurl/{http_path}"
        try:
            with rasterio.open(vsi_path) as src:
                left, bottom, right, top = transform_bounds("EPSG:4326", src.crs, qminx, qminy, qmaxx, qmaxy)
                r1, c1 = src.index(left, top)
                r2, c2 = src.index(right, bottom)
                row_start = max(0, min(r1, r2, src.height))
                row_end = max(0, min(max(r1, r2), src.height))
                col_start = max(0, min(c1, c2, src.width))
                col_end = max(0, min(max(c1, c2), src.width))
                if row_end <= row_start or col_end <= col_start:
                    continue
                window = Window(col_start, row_start, col_end - col_start, row_end - row_start)
                src_data = src.read(window=window, out_dtype=np.float32)  # native res, no decimation
                window_transform = rasterio.windows.transform(window, src.transform)
                for b in range(64):
                    temp = np.zeros(qshape, dtype=np.float32)
                    reproject(
                        source=src_data[b],
                        destination=temp,
                        src_transform=window_transform,
                        src_crs=src.crs,
                        dst_transform=qtt,
                        dst_crs="EPSG:4326",
                        resampling=Resampling.nearest,  # preserve pure embeddings
                        src_nodata=src.nodata,
                        dst_nodata=np.nan,
                    )
                    m = ~np.isnan(temp)
                    qbands[b, m] = temp[m]
        except Exception:
            continue

    qmask = geometry_mask(q_geoms, out_shape=qshape, transform=qtt, invert=True, all_touched=True)
    qmask = qmask & (~np.isnan(qbands).any(axis=0))
    qp = qbands[:, qmask].T
    if len(qp) == 0:
        return None
    # Return the raw-scale mean embedding so callers can either unit-normalize it
    # (dot-product mode) or subtract the ROI mean from it (centered mode).
    return qp.mean(axis=0)


@app.post("/api/aef/similarity")
def search_aef_similarity(req: AefSimilarityRequest):
    clean_old_static_files()
    
    # 1. Resolve index path
    index_path = os.path.join(STATIC_DIR, "aef_index.parquet")
    workspace_index = os.path.join(os.path.dirname(BASE_DIR), "aef_index.parquet")
    if os.path.exists(workspace_index):
        index_path = workspace_index
    elif not os.path.exists(index_path):
        import requests
        url = "https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        try:
            res = requests.get(url, headers=headers, timeout=60)
            if res.status_code == 200:
                with open(index_path, "wb") as f:
                    f.write(res.content)
            else:
                raise HTTPException(status_code=500, detail=f"Failed to download AEF index: HTTP {res.status_code}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to retrieve AEF index: {str(e)}")

    # 2. Read parquet index
    import pandas as pd
    try:
        df = pd.read_parquet(index_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load AEF index: {str(e)}")

    # 3. Query overlapping tiles
    df_year = df[df["year"] == req.year]
    min_lon, min_lat, max_lon, max_lat = req.bbox
    
    overlapping = df_year[
        (df_year["wgs84_west"] <= max_lon) &
        (df_year["wgs84_east"] >= min_lon) &
        (df_year["wgs84_south"] <= max_lat) &
        (df_year["wgs84_north"] >= min_lat)
    ]
    
    if len(overlapping) == 0:
        raise HTTPException(
            status_code=404,
            detail=f"No AlphaEarth satellite embedding tiles found for year {req.year} in the selected area."
        )

    # 4. Define target grid in EPSG:4326 (capped at 150x150 for speed)
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    width = max(10, min(width, 150))
    height = max(10, min(height, 150))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    # Prepare array to hold the 64 embedding bands
    bands_data = np.full((64, height, width), np.nan, dtype=np.float32)

    try:
        for _, row in overlapping.iterrows():
            s3_path = row["path"]
            http_path = s3_path.replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
            vsi_path = f"/vsicurl/{http_path}"
            
            with rasterio.open(vsi_path) as src:
                src_bbox = transform_bounds("EPSG:4326", src.crs, min_lon, min_lat, max_lon, max_lat)
                left, bottom, right, top = src_bbox
                
                row1, col1 = src.index(left, top)
                row2, col2 = src.index(right, bottom)
                
                row_start = max(0, min(row1, row2, src.height))
                row_end = max(0, min(max(row1, row2), src.height))
                col_start = max(0, min(col1, col2, src.width))
                col_end = max(0, min(max(col1, col2), src.width))
                
                if row_end > row_start and col_end > col_start:
                    from rasterio.windows import Window
                    from rasterio.transform import Affine
                    window = Window(col_start, row_start, col_end - col_start, row_end - row_start)
                    
                    src_data = src.read(out_shape=(64, height, width), window=window, out_dtype=np.float32)
                    window_transform = rasterio.windows.transform(window, src.transform)
                    scale_x = window.width / width
                    scale_y = window.height / height
                    decimated_transform = window_transform * Affine.scale(scale_x, scale_y)
                    
                    for b in range(1, 65):
                        temp_dest = np.zeros(target_shape, dtype=np.float32)
                        reproject(
                            source=src_data[b-1],
                            destination=temp_dest,
                            src_transform=decimated_transform,
                            src_crs=src.crs,
                            dst_transform=target_transform,
                            dst_crs=target_crs,
                            resampling=Resampling.bilinear,
                            src_nodata=src.nodata,
                            dst_nodata=np.nan
                        )
                        mask = ~np.isnan(temp_dest)
                        bands_data[b-1, mask] = temp_dest[mask]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read satellite embeddings: {str(e)}")

    # Extract valid mask for the ROI
    valid_mask = ~np.isnan(bands_data).any(axis=0)
    valid_mask_flat = valid_mask.flatten()

    # Apply custom ROI geometry mask if provided
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            mask = geometry_mask(geoms, out_shape=target_shape, transform=target_transform, invert=False)
            for b in range(64):
                bands_data[b, mask] = np.nan
            valid_mask = ~np.isnan(bands_data).any(axis=0)
            valid_mask_flat = valid_mask.flatten()

    # 5. Extract Query Feature reference vector
    from rasterio.features import geometry_mask
    ref_vector = None
    try:
        q_geoms = extract_geojson_geometries(req.query_geometry)
        if not q_geoms:
            raise ValueError("Could not parse query geometry - no valid geometries found")
        
        # Preferred: sample the reference at native ~10 m resolution so small,
        # distinct features (e.g. water bodies) are not blended with their
        # surroundings on the coarse ROI grid.
        ref_vector = sample_native_query_reference(overlapping, q_geoms)

        if ref_vector is None or np.isnan(ref_vector).any():
            # Fallback 1: average the query pixels on the coarse ROI grid.
            # all_touched=True so a small polygon still captures pixels.
            q_mask = geometry_mask(q_geoms, out_shape=target_shape, transform=target_transform, invert=True, all_touched=True)
            q_mask = q_mask & valid_mask

            query_pixels = bands_data[:, q_mask].T  # shape (N_query_pixels, 64)

            if len(query_pixels) > 0 and not np.isnan(query_pixels).all():
                # Raw-scale mean embedding of the query pixels (normalized or
                # ROI-centered later depending on the similarity mode).
                ref_vector = np.nanmean(query_pixels, axis=0)
            else:
                # Fallback 2: compute centroid and find the nearest valid pixel.
                try:
                    qg = req.query_geometry
                    if qg.get("type") == "Feature":
                        coords = qg["geometry"]["coordinates"][0]
                    elif qg.get("type") == "Polygon":
                        coords = qg["coordinates"][0]
                    else:
                        coords = qg.get("geometry", qg).get("coordinates", [[]])[0]

                    avg_lon = sum(pt[0] for pt in coords) / len(coords)
                    avg_lat = sum(pt[1] for pt in coords) / len(coords)
                except Exception:
                    # Ultimate fallback: use center of bbox
                    avg_lon = (req.bbox[0] + req.bbox[2]) / 2.0
                    avg_lat = (req.bbox[1] + req.bbox[3]) / 2.0

                col_f, row_f = ~target_transform * (avg_lon, avg_lat)
                center_col = int(np.clip(col_f, 0, width - 1))
                center_row = int(np.clip(row_f, 0, height - 1))

                # Try the centroid pixel first (raw-scale, single reference)
                candidate = bands_data[:, center_row, center_col]
                if not np.isnan(candidate).any():
                    ref_vector = candidate
                else:
                    # Scan expanding neighborhood for nearest valid pixel
                    for radius in range(1, max(height, width)):
                        found = False
                        for dr in range(-radius, radius + 1):
                            for dc in range(-radius, radius + 1):
                                r, c = center_row + dr, center_col + dc
                                if 0 <= r < height and 0 <= c < width:
                                    px = bands_data[:, r, c]
                                    if not np.isnan(px).any():
                                        ref_vector = px
                                        found = True
                                        break
                            if found:
                                break
                        if found:
                            break
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to extract query feature geometry: {str(e)}")

    if ref_vector is None or np.isnan(ref_vector).any():
        raise HTTPException(
            status_code=400,
            detail="The drawn query feature lies completely in a no-data region. Please draw your query polygon over an area with visible satellite data inside the Target ROI."
        )

    # 6. Compute similarity for every valid pixel.
    #
    # AlphaEarth embeddings are unit-length, so a dot product equals the cosine of
    # the angle between vectors. Two modes:
    #
    #  * "dotproduct" (Google's literal method): unit-normalize each pixel and dot
    #    it with the reference. Faithful to the Earth Engine tutorial
    #    (arrayImage.multiply(mosaic).reduce('sum')). Works well in diverse scenes,
    #    but in homogeneous ROIs the embeddings share a large common component, so
    #    the MOST distinctive features (e.g. water) can rank BELOW the background.
    #
    #  * "centered" (default): subtract the ROI-mean embedding from every pixel and
    #    from the reference before the cosine. This removes the shared component so
    #    distinct features are correctly ranked highest. Required for reliable
    #    feature search (water, built-up, etc.) over uniform terrain.
    valid_pixels = bands_data.reshape(64, -1).T[valid_mask_flat]

    if len(valid_pixels) == 0:
         raise HTTPException(status_code=400, detail="No active pixels inside the ROI.")

    mode = (req.mode or "centered").lower()

    if mode == "dotproduct":
        ref_unit = ref_vector / (np.linalg.norm(ref_vector) or 1e-6)
        pixel_norms = np.linalg.norm(valid_pixels, axis=1, keepdims=True)
        pixel_norms[pixel_norms == 0] = 1e-6
        similarities = (valid_pixels / pixel_norms) @ ref_unit
    else:
        mode = "centered"
        roi_mean = valid_pixels.mean(axis=0)
        ref_c = ref_vector - roi_mean
        ref_c = ref_c / (np.linalg.norm(ref_c) or 1e-6)
        centered = valid_pixels - roi_mean
        c_norms = np.linalg.norm(centered, axis=1, keepdims=True)
        c_norms[c_norms == 0] = 1e-6
        similarities = (centered / c_norms) @ ref_c

    # Reconstruct similarity map
    sim_map = np.full(height * width, np.nan, dtype=np.float32)
    sim_map[valid_mask_flat] = similarities
    sim_map = sim_map.reshape(height, width)

    # 7. Calculate Match Stats. Default threshold differs by mode: dot-product
    # similarities cluster high (~0.9), centered ones spread around 0.
    if req.threshold is not None:
        threshold = req.threshold
    else:
        threshold = 0.9 if mode == "dotproduct" else 0.5
    match_pixels = int(np.sum(sim_map[valid_mask] >= threshold))
    total_valid_pixels = int(np.sum(valid_mask))
    match_percentage = (match_pixels / total_valid_pixels) * 100.0 if total_valid_pixels > 0 else 0.0

    lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((req.bbox[2] - req.bbox[0]) / width) * m_per_deg_lon
    pixel_h_m = ((req.bbox[3] - req.bbox[1]) / height) * m_per_deg_lat
    pixel_area_m2 = pixel_w_m * pixel_h_m
    
    match_area_ha = (match_pixels * pixel_area_m2) / 10000.0

    stats = calculate_roi_stats(sim_map)
    stats["match_pixels"] = match_pixels
    stats["match_percentage"] = round(match_percentage, 2)
    stats["match_area_ha"] = round(match_area_ha, 2)
    stats["threshold"] = threshold

    # 8. Save outputs
    req_id = str(uuid.uuid4())
    png_filename = f"{req_id}_aef_similarity.png"
    tiff_filename = f"{req_id}_aef_similarity.tif"
    
    png_path = os.path.join(STATIC_DIR, png_filename)
    tiff_path = os.path.join(STATIC_DIR, tiff_filename)

    palette_colors = get_color_palette(req.palette or "Magma (Sequential)")

    # Render the FULL continuous similarity as a heatmap (brighter = more similar).
    #  * dotproduct: fixed [0, 1] range, faithful to Google's {min:0, max:1}.
    #  * centered: similarities spread around 0, so stretch to the data's own
    #    [p2, p98] range for visible contrast (distinct features stand out).
    if mode == "dotproduct":
        vmin, vmax = 0.0, 1.0
    else:
        vmin = float(stats.get("p2", 0.0))
        vmax = float(stats.get("p98", 1.0))
        if vmax <= vmin:
            vmax = vmin + 0.1

    save_visual_png(sim_map, vmin, vmax, palette_colors, png_path)
    save_geotiff(sim_map, target_transform, target_crs, tiff_path)

    return {
        "req_id": req_id,
        "image_url": f"/api/static/{png_filename}",
        "geotiff_url": f"/api/static/{tiff_filename}",
        "stats": stats,
        "bbox": req.bbox,
        "year": req.year,
        "threshold": threshold,
        "mode": mode,
        "vis_min": vmin,
        "vis_max": vmax
    }

@app.get("/api/static/{filename}")
def serve_static(filename: str):
    file_path = os.path.join(STATIC_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")
