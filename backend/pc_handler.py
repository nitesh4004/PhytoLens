import os
import re
import numpy as np
import pystac_client
import planetary_computer
import rasterio
from rasterio.warp import transform_bounds, reproject, Resampling
from rasterio.transform import from_origin
from PIL import Image
import matplotlib.colors as mcolors

# Initialize Planetary Computer Catalog
STAC_API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

def get_catalog():
    return pystac_client.Client.open(STAC_API_URL, modifier=planetary_computer.sign_inplace)

def extract_geojson_geometries(geojson):
    if not geojson:
        return []
    if isinstance(geojson, dict):
        if geojson.get("type") == "FeatureCollection":
            return [f["geometry"] for f in geojson.get("features", []) if f.get("geometry")]
        elif geojson.get("type") == "Feature":
            return [geojson["geometry"]] if geojson.get("geometry") else []
        elif "geometry" in geojson:
            return [geojson["geometry"]]
        else:
            return [geojson]
    return []


def search_stac(collection, bbox, date_range, cloud_cover=None, orbit=None, limit=50):
    """
    Search Planetary Computer STAC.
    bbox: [min_lon, min_lat, max_lon, max_lat]
    date_range: 'YYYY-MM-DD/YYYY-MM-DD'
    """
    catalog = get_catalog()
    query = {}
    
    # Apply cloud cover constraints for optical collections
    if cloud_cover is not None and collection in ["sentinel-2-l2a", "landsat-c2-l2"]:
        query["eo:cloud_cover"] = {"lt": cloud_cover}
        
    # Apply orbit state filters for Sentinel-1 Radar
    if orbit is not None and orbit != "BOTH" and collection == "sentinel-1-grd":
        # In STAC, orbit state is sat:orbit_state
        query["sat:orbit_state"] = {"eq": orbit.lower()}

    search = catalog.search(
        collections=[collection],
        bbox=bbox,
        datetime=date_range,
        query=query,
        limit=limit
    )
    
    items = search.item_collection()
    results = []
    
    for item in items:
        # Extract properties
        date_str = item.properties.get("datetime", "")
        if date_str:
            date_str = date_str.split("T")[0]
            
        cc = item.properties.get("eo:cloud_cover", None)
        thumb = item.assets.get("thumbnail", None)
        thumb_url = thumb.href if thumb else ""
        
        results.append({
            "id": item.id,
            "date": date_str,
            "cloud_cover": cc,
            "thumbnail": thumb_url,
            "properties": item.properties
        })
        
    # Sort by date descending
    results.sort(key=lambda x: x["date"], reverse=True)
    return results, items

def read_aligned_bands(item, bbox_wgs84, band_mapping, target_resolution=10):
    """
    Fetch, crop, and align raster bands from a STAC Item to EPSG:4326 grid inside bbox.
    bbox_wgs84: [min_lon, min_lat, max_lon, max_lat]
    band_mapping: dict of app_band_name -> pc_asset_name
    """
    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    
    # 1. Define resolution in degrees (approximately 10m = 0.00009 degrees)
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = target_resolution * deg_per_meter
    
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))
    
    # Cap dimensions to avoid out-of-memory or timeout errors (max 1500x1500)
    width = max(10, min(width, 1500))
    height = max(10, min(height, 1500))
    
    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    
    # Affine transform for EPSG:4326
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"
    
    aligned_data = {}
    
    for app_band, asset_name in band_mapping.items():
        if asset_name not in item.assets:
            continue
            
        signed_href = planetary_computer.sign(item.assets[asset_name].href)
        
        with rasterio.open(signed_href) as src:
            dest = np.zeros(target_shape, dtype=np.float32)
            
            # Reproject source asset bounding slice directly into destination array
            reproject(
                source=rasterio.band(src, 1),
                destination=dest,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=target_transform,
                dst_crs=target_crs,
                resampling=Resampling.bilinear,
                src_nodata=src.nodata,
                dst_nodata=0.0
            )
            
            # Replace nan/infinite with 0
            dest = np.nan_to_num(dest)
            aligned_data[app_band] = dest
            
    return aligned_data, target_transform, target_crs

def calculate_index(bands_data, platform, index_name, formula=None):
    """
    Compute spectral indices or custom formulas on aligned numpy arrays.
    """
    # Normalize optical bands to reflectance if Sentinel-2 (assets are scaled by 10000 in raw Sentinel)
    # Note: MPC Sentinel-2 L2A assets are raw DN values scaled by 10000.
    # Landsat C2 L2 surface reflectance are scaled by 2.75e-5 and offset by -0.2.
    scaled_bands = {}
    
    if platform == "Sentinel-2 (Optical)":
        for b, arr in bands_data.items():
            scaled_bands[b] = arr / 10000.0
    elif "Landsat" in platform:
        for b, arr in bands_data.items():
            if b in ["B1", "B2", "B3", "B4", "B5", "B6", "B7"]:
                scaled_bands[b] = arr * 0.0000275 - 0.2
            elif b in ["B10", "ST_B10"]:
                # Brightness temp in Kelvin
                scaled_bands[b] = arr * 0.00341802 + 149.0
            else:
                scaled_bands[b] = arr
    else:
        # Sentinel-1 Radar or DEM - use values directly
        scaled_bands = bands_data

    # Calculate index
    if index_name == "NDVI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        red = scaled_bands.get("B4")
        if nir is not None and red is not None:
            denom = (nir + red)
            denom[denom == 0] = 1e-6
            return (nir - red) / denom
            
    elif index_name == "GNDVI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        green = scaled_bands.get("B3")
        if nir is not None and green is not None:
            denom = (nir + green)
            denom[denom == 0] = 1e-6
            return (nir - green) / denom
            
    elif index_name == "NDWI (Water)" or index_name == "NDWI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        green = scaled_bands.get("B3")
        if nir is not None and green is not None:
            denom = (green + nir)
            denom[denom == 0] = 1e-6
            return (green - nir) / denom
            
    elif index_name == "NDMI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        swir1 = scaled_bands.get("B11") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B6")
        if nir is not None and swir1 is not None:
            denom = (nir + swir1)
            denom[denom == 0] = 1e-6
            return (nir - swir1) / denom
            
    elif index_name == "LST (Thermal)":
        # Convert Kelvin to Celsius: K - 273.15
        thermal = scaled_bands.get("ST_B10") or scaled_bands.get("B10")
        if thermal is not None:
            return thermal - 273.15
            
    elif index_name == "VV" and "Sentinel-1" in platform:
        return scaled_bands.get("VV")
        
    elif index_name == "VH" and "Sentinel-1" in platform:
        return scaled_bands.get("VH")
        
    elif index_name == "VH/VV Ratio" and "Sentinel-1" in platform:
        vv = scaled_bands.get("VV")
        vh = scaled_bands.get("VH")
        if vv is not None and vh is not None:
            # S1 GRD backscatter on MPC is typically in decibel scale (dB) already
            # If in dB, VH/VV ratio is vh - vv (since log(A/B) = log(A) - log(B))
            return vh - vv

    elif "Custom" in index_name and formula:
        # Run safe evaluation of custom formula
        # Clean formula string: B8, B4 -> scaled_bands['B8'], scaled_bands['B4']
        try:
            # Create a dictionary containing ONLY the numpy arrays
            expr_vars = {k: v for k, v in scaled_bands.items()}
            # Replace band terms like B8A with dict lookups or keep them as keys
            # To evaluate safely, we can map math operators and np functions
            expr_vars["np"] = np
            
            # Simple expression evaluation (caution: formula must be sanitized)
            # Standard custom band expressions: (B8 - B4) / (B8 + B4)
            # We replace variable names with dictionary keys
            clean_formula = formula
            # Match variables (capital letters followed by numbers, e.g. B8, B11, B8A)
            bands_found = re.findall(r'\bB[0-9]+[A-Z]?\b|\bVV\b|\bVH\b|\bST_B10\b', formula)
            for bf in bands_found:
                if bf in expr_vars:
                    # In python eval, variable names can match dict keys directly
                    pass
            
            result = eval(clean_formula, {"__builtins__": None}, expr_vars)
            return result
        except Exception as e:
            raise ValueError(f"Custom formula evaluation failed: {e}")
            
    raise ValueError(f"Unknown index or platform: {index_name}")

def calculate_roi_stats(data):
    """Calculate statistics of calculated raster array."""
    valid_data = data[~np.isnan(data) & ~np.isinf(data)]
    if len(valid_data) == 0:
        return {"min": 0, "max": 0, "mean": 0, "std": 0}
        
    p2 = float(np.percentile(valid_data, 2))
    p98 = float(np.percentile(valid_data, 98))
    
    return {
        "min": float(np.min(valid_data)),
        "max": float(np.max(valid_data)),
        "mean": float(np.mean(valid_data)),
        "std": float(np.std(valid_data)),
        "p2": p2,
        "p98": p98
    }

def get_color_palette(name):
    palettes = {
        "Red-Yellow-Green (Vegetation)": ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'],
        "Blue-White-Green (Water/Veg)": ['#0000ff', '#ffffff', '#008000'],
        "Blue-Yellow-Red (Thermal)": ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'],
        "Viridis (Sequential)": ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
        "Magma (Sequential)": ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fcfdbf'],
        "Inferno (Sequential)": ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746'],
        "Plasma (Sequential)": ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
        "Turbo (Rainbow Enhanced)": ['#30123b', '#466be3', '#28bbec', '#32f197', '#a2fc3c', '#f2f221', '#fc8961', '#cf2547', '#7a0403'],
        "Ocean (Water Depth)": ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'],
        "Terrain (Elevation)": ['#006400', '#32CD32', '#FFFF00', '#DAA520', '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#F4A460', '#DEB887', '#D3D3D3', '#FFFFFF'],
        "Greyscale": ['#000000', '#FFFFFF']
    }
    return palettes.get(name, palettes["Red-Yellow-Green (Vegetation)"])

def save_visual_png(data, vmin, vmax, palette_colors, output_path):
    """
    Map array to RGB based on color palette and stretch values, and save as PNG.
    """
    # Replace nan/inf
    clean_data = np.nan_to_num(data, nan=vmin)
    
    # Normalize index array to [0, 1] using vmin and vmax
    if vmax == vmin:
        vmax = vmin + 1e-6
    norm_data = (clean_data - vmin) / (vmax - vmin)
    norm_data = np.clip(norm_data, 0.0, 1.0)
    
    # Create matplotlib colormap
    cmap = mcolors.LinearSegmentedColormap.from_list("custom", palette_colors)
    rgba = cmap(norm_data)
    
    # Keep transparency where data was originally NaN/inf or completely 0 (no data)
    alpha = np.ones(clean_data.shape, dtype=np.uint8) * 255
    alpha[np.isnan(data)] = 0
    
    # Combine RGB with Alpha channel
    rgb = (rgba[:, :, :3] * 255).astype(np.uint8)
    rgba_output = np.dstack((rgb, alpha))
    
    img = Image.fromarray(rgba_output, "RGBA")
    img.save(output_path, "PNG")

def save_geotiff(data, transform, crs, output_path):
    """
    Export single-band raw float raster to GeoTIFF format.
    """
    height, width = data.shape
    with rasterio.open(
        output_path,
        'w',
        driver='GTiff',
        height=height,
        width=width,
        count=1,
        dtype=rasterio.float32,
        crs=crs,
        transform=transform,
        nodata=np.nan
    ) as dst:
        dst.write(data.astype(rasterio.float32), 1)


# ============================================================
# LULC (Land Use / Land Cover) Processing Functions
# ============================================================

# ESA WorldCover 10m — 11 discrete classes
ESA_WORLDCOVER_LEGEND = {
    10:  {"name": "Tree cover",              "color": "#006400"},
    20:  {"name": "Shrubland",               "color": "#ffbb22"},
    30:  {"name": "Grassland",               "color": "#ffff4c"},
    40:  {"name": "Cropland",                "color": "#f096ff"},
    50:  {"name": "Built-up",                "color": "#fa0000"},
    60:  {"name": "Bare / sparse vegetation", "color": "#b4b4b4"},
    70:  {"name": "Snow and ice",            "color": "#f0f0f0"},
    80:  {"name": "Permanent water bodies",  "color": "#0064c8"},
    90:  {"name": "Herbaceous wetland",      "color": "#0096a0"},
    95:  {"name": "Mangroves",               "color": "#00cf75"},
    100: {"name": "Moss and lichen",         "color": "#fae6a0"},
}

# Impact Observatory 10m Annual LULC v02 — 9 discrete classes
IO_LULC_LEGEND = {
    1: {"name": "Water",              "color": "#419bdf"},
    2: {"name": "Trees",              "color": "#397d49"},
    3: {"name": "Flooded Vegetation", "color": "#7a87c6"},
    4: {"name": "Crops",              "color": "#e49635"},
    5: {"name": "Built Area",         "color": "#c4281b"},
    6: {"name": "Bare Ground",        "color": "#a59b8f"},
    7: {"name": "Snow/Ice",           "color": "#a8ebff"},
    8: {"name": "Clouds",             "color": "#616161"},
    9: {"name": "Rangeland",          "color": "#e3e2c3"},
}


def get_lulc_legend(dataset):
    """Return the class legend dict for the specified LULC dataset."""
    if dataset == "esa-worldcover":
        return ESA_WORLDCOVER_LEGEND
    elif dataset == "io-lulc":
        return IO_LULC_LEGEND
    else:
        raise ValueError(f"Unknown LULC dataset: {dataset}")


def fetch_lulc_raster(bbox_wgs84, dataset, year):
    """
    Search Planetary Computer STAC for the requested LULC dataset and year,
    fetch the classification raster, crop to bbox, and reproject to EPSG:4326.
    Returns: (class_array, transform, crs)
    """
    catalog = get_catalog()

    if dataset == "esa-worldcover":
        collection_name = "esa-worldcover"
        asset_key = "map"
    elif dataset == "io-lulc":
        collection_name = "io-lulc-annual-v02"
        asset_key = "data"
    else:
        raise ValueError(f"Unknown LULC dataset: {dataset}")

    date_range = f"{year}-01-01/{year}-12-31"

    search = catalog.search(
        collections=[collection_name],
        bbox=bbox_wgs84,
        datetime=date_range,
        limit=10
    )

    items = search.item_collection()
    if len(items) == 0:
        raise ValueError(f"No {dataset} items found for year {year} in the given area.")

    # Pick the first matching item
    item = items[0]

    if asset_key not in item.assets:
        raise ValueError(f"Asset '{asset_key}' not found in STAC item {item.id}.")

    signed_href = planetary_computer.sign(item.assets[asset_key].href)

    min_lon, min_lat, max_lon, max_lat = bbox_wgs84

    # Define target grid in EPSG:4326
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    # Cap dimensions
    width = max(10, min(width, 2000))
    height = max(10, min(height, 2000))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height

    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    with rasterio.open(signed_href) as src:
        dest = np.zeros(target_shape, dtype=np.uint8)

        reproject(
            source=rasterio.band(src, 1),
            destination=dest,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=target_transform,
            dst_crs=target_crs,
            resampling=Resampling.nearest,   # Nearest-neighbor for categorical data
            src_nodata=src.nodata if src.nodata is not None else 0,
            dst_nodata=0
        )

    return dest, target_transform, target_crs


def colorize_lulc_png(class_array, legend, output_path):
    """
    Map discrete class values to their canonical RGBA colors and save as PNG.
    Pixels with value 0 (nodata) are made transparent.
    """
    height, width = class_array.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)

    for class_val, info in legend.items():
        hex_color = info["color"]
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)

        mask = class_array == class_val
        rgba[mask, 0] = r
        rgba[mask, 1] = g
        rgba[mask, 2] = b
        rgba[mask, 3] = 255

    # Nodata pixels (value 0 or unmatched) remain fully transparent (alpha=0)
    img = Image.fromarray(rgba, "RGBA")
    img.save(output_path, "PNG")


def compute_lulc_stats(class_array, legend, pixel_area_m2=100.0):
    """
    Count pixels per class and compute area statistics.
    pixel_area_m2: approximate area of one pixel in square meters (default 100 = 10m × 10m).
    Returns dict: { class_value: { name, color, pixel_count, area_ha, percentage } }
    """
    total_valid = int(np.sum(class_array > 0))
    if total_valid == 0:
        return {}

    stats = {}
    for class_val, info in legend.items():
        count = int(np.sum(class_array == class_val))
        if count == 0:
            continue
        area_ha = (count * pixel_area_m2) / 10000.0  # 1 ha = 10000 m²
        percentage = (count / total_valid) * 100.0

        stats[str(class_val)] = {
            "name": info["name"],
            "color": info["color"],
            "pixel_count": count,
            "area_ha": round(area_ha, 2),
            "percentage": round(percentage, 2)
        }

    return stats

