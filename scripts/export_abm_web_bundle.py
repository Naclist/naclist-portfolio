from __future__ import annotations

import argparse
import gzip
import json
import struct
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq


def read(path: Path, columns: list[str]) -> dict[str, np.ndarray]:
    table = pq.read_table(path, columns=columns)
    return {name: table[name].to_numpy() for name in table.column_names}


def rounded(*values: float) -> list[float]:
    return [round(float(value), 4) for value in values]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export the 10K ABM city as a compact browser bundle"
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--sample-stride", type=int, default=4)
    args = parser.parse_args()
    source = args.source.resolve()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)

    roads = read(
        source / "road_segments.parquet",
        [
            "x1", "y1", "x2", "y2", "road_type", "width", "daily_flow",
            "public_transport_flow", "walk_flow", "car_flow", "capacity_ratio",
        ],
    )
    blocks = read(
        source / "urban_blocks.parquet",
        [
            "block_id", "min_x", "min_y", "max_x", "max_y", "land_use",
            "population", "jobs", "population_density", "transport_accessibility",
        ],
    )
    buildings = read(
        source / "buildings.parquet",
        [
            "location_id", "block_id", "min_x", "min_y", "max_x", "max_y",
            "building_type", "height_class", "occupancy",
        ],
    )
    population = read(
        source / "population.parquet",
        [
            "agent_id", "age", "sex", "occupation", "occupation_detail", "mobility",
            "household_id", "life_stage", "work_shift", "income",
            "community_id", "home_id", "primary_location", "healthcare_role",
            "institution_type", "grade_id", "class_id",
        ],
    )
    nodes = read(source / "environment_nodes.parquet", ["id", "x", "y"])
    facilities = read(
        source / "healthcare_facilities.parquet",
        ["facility_id", "facility_type", "location_id", "capacity", "occupied_beds"],
    )
    node_x = np.empty(int(nodes["id"].max()) + 1, dtype=np.float32)
    node_y = np.empty_like(node_x)
    node_x[nodes["id"].astype(int)] = nodes["x"]
    node_y[nodes["id"].astype(int)] = nodes["y"]
    location_block = {
        int(location): int(block)
        for location, block in zip(
            buildings["location_id"], buildings["block_id"], strict=True
        )
    }

    city = {
        "schema": "synthetic-city-web-v1",
        "bounds": [0.0, 0.0, 25.0, 25.0],
        "grid": [20, 20],
        "road_classes": ["local", "collector", "arterial", "service", "pedestrian"],
        "roads": [
            [
                *rounded(x1, y1, x2, y2), int(road_type), round(float(width), 2),
                int(daily), int(transit), int(walk), int(car), round(float(ratio), 3),
            ]
            for x1, y1, x2, y2, road_type, width, daily, transit, walk, car, ratio
            in zip(
                roads["x1"], roads["y1"], roads["x2"], roads["y2"],
                roads["road_type"], roads["width"], roads["daily_flow"],
                roads["public_transport_flow"], roads["walk_flow"],
                roads["car_flow"], roads["capacity_ratio"], strict=True,
            )
        ],
        "blocks": [
            [
                int(block_id), *rounded(min_x, min_y, max_x, max_y), int(land_use),
                int(population_count), int(jobs), round(float(density), 2),
                round(float(transit), 3),
            ]
            for block_id, min_x, min_y, max_x, max_y, land_use, population_count,
            jobs, density, transit in zip(
                blocks["block_id"], blocks["min_x"], blocks["min_y"],
                blocks["max_x"], blocks["max_y"], blocks["land_use"],
                blocks["population"], blocks["jobs"], blocks["population_density"],
                blocks["transport_accessibility"], strict=True,
            )
        ],
        "buildings": [
            [
                int(block_id), *rounded(min_x, min_y, max_x, max_y),
                int(building_type), int(height), int(occupancy),
            ]
            for block_id, min_x, min_y, max_x, max_y, building_type, height, occupancy
            in zip(
                buildings["block_id"], buildings["min_x"], buildings["min_y"],
                buildings["max_x"], buildings["max_y"], buildings["building_type"],
                buildings["height_class"], buildings["occupancy"], strict=True,
            )
        ],
        "facilities": [
            [
                int(facility_id), int(facility_type),
                *rounded(node_x[int(location)], node_y[int(location)]),
                int(capacity), int(occupied),
            ]
            for facility_id, facility_type, location, capacity, occupied in zip(
                facilities["facility_id"], facilities["facility_type"],
                facilities["location_id"], facilities["capacity"],
                facilities["occupied_beds"], strict=True,
            )
        ],
        "agents": {
            "block": [location_block.get(int(home), -1) for home in population["home_id"]],
            "age": population["age"].astype(int).tolist(),
            "sex": population["sex"].astype(int).tolist(),
            "occupation": population["occupation"].astype(int).tolist(),
            "occupation_detail": population["occupation_detail"].astype(int).tolist(),
            "mobility": population["mobility"].astype(int).tolist(),
            "household": population["household_id"].astype(int).tolist(),
            "life_stage": population["life_stage"].astype(int).tolist(),
            "work_shift": population["work_shift"].astype(int).tolist(),
            "income": np.rint(population["income"]).astype(int).tolist(),
            "community": population["community_id"].astype(int).tolist(),
            "home": population["home_id"].astype(int).tolist(),
            "primary_location": population["primary_location"].astype(int).tolist(),
            "primary_block": [location_block.get(int(location), -1) for location in population["primary_location"]],
            "healthcare_role": population["healthcare_role"].astype(int).tolist(),
            "institution_type": population["institution_type"].astype(int).tolist(),
            "grade_id": population["grade_id"].astype(int).tolist(),
            "class_id": population["class_id"].astype(int).tolist(),
        },
    }
    city_json = json.dumps(city, separators=(",", ":")).encode("utf-8")
    with gzip.open(destination / "city-10k.json.gz", "wb", compresslevel=9) as handle:
        handle.write(city_json)

    schedule = read(source / "agent_schedule.parquet", ["agent_id", "time", "x", "y"])
    agent_count = len(population["agent_id"])
    total_steps = len(schedule["time"]) // agent_count
    stride = max(1, int(args.sample_stride))
    sampled_steps = np.arange(0, total_steps, stride, dtype=np.int32)
    x = schedule["x"].astype(np.float32).reshape(agent_count, total_steps)[:, sampled_steps].T
    y = schedule["y"].astype(np.float32).reshape(agent_count, total_steps)[:, sampled_steps].T
    positions = np.empty((len(sampled_steps), agent_count, 2), dtype="<u2")
    positions[:, :, 0] = np.rint(np.clip(x / 25.0, 0, 1) * 65535).astype(np.uint16)
    positions[:, :, 1] = np.rint(np.clip(y / 25.0, 0, 1) * 65535).astype(np.uint16)
    header = struct.pack(
        "<4sIHHHH", b"ABM1", agent_count, len(sampled_steps), stride, 20, 20
    )
    with gzip.open(destination / "mobility-10k.bin.gz", "wb", compresslevel=9) as handle:
        handle.write(header)
        handle.write(positions.tobytes(order="C"))

    manifest = {
        "schema": "synthetic-city-web-v1",
        "population": agent_count,
        "simulation_steps": total_steps,
        "sample_stride": stride,
        "mobility_samples": len(sampled_steps),
        "city_file": "city-10k.json.gz",
        "mobility_file": "mobility-10k.bin.gz",
        "source": source.name,
        "interpretation": "Synthetic demonstration data; not real geography.",
    }
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps({
        **manifest,
        "roads": len(city["roads"]),
        "blocks": len(city["blocks"]),
        "buildings": len(city["buildings"]),
        "city_gzip_mb": round((destination / "city-10k.json.gz").stat().st_size / 2**20, 3),
        "mobility_gzip_mb": round((destination / "mobility-10k.bin.gz").stat().st_size / 2**20, 3),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
