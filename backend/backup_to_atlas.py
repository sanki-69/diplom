"""
backup_to_atlas.py
------------------
Copies all collections from local MongoDB → MongoDB Atlas.

Usage:
  1. Add your Atlas URL to backend/.env:
       ATLAS_URL=mongodb+srv://user:pass@cluster.mongodb.net/
  2. Run:
       python backup_to_atlas.py

How to get your Atlas URL:
  https://cloud.mongodb.com → Clusters → Connect → Drivers → Python 3.6+
  Free tier (M0) is enough for this project.
"""

import os
import sys
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

LOCAL_URL  = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
DB_NAME    = os.getenv("MONGODB_DB",  "aishop")
ATLAS_URL  = (os.getenv("ATLAS_URL") or "").strip()

SKIP_COLLECTIONS = {"scraped_products"}  # too large / regenerated on use


def backup():
    if not ATLAS_URL:
        print("ERROR: ATLAS_URL is empty in .env")
        print("       Add your Atlas connection string and run again.")
        sys.exit(1)

    print(f"Connecting to local MongoDB at {LOCAL_URL} ...")
    local_client = MongoClient(LOCAL_URL, serverSelectionTimeoutMS=5000)
    local_db     = local_client[DB_NAME]

    print(f"Connecting to Atlas ...")
    atlas_client = MongoClient(ATLAS_URL, serverSelectionTimeoutMS=10000)
    # Use the same DB name on Atlas
    atlas_db     = atlas_client[DB_NAME]

    collections = local_db.list_collection_names()
    print(f"Collections found: {collections}\n")

    for col_name in collections:
        if col_name in SKIP_COLLECTIONS:
            print(f"  Skipping  {col_name} (excluded)")
            continue

        local_col = local_db[col_name]
        atlas_col = atlas_db[col_name]

        docs = list(local_col.find({}))
        if not docs:
            print(f"  Empty     {col_name}")
            continue

        # Upsert by _id so re-running is safe
        upserted = 0
        for doc in docs:
            atlas_col.replace_one({"_id": doc["_id"]}, doc, upsert=True)
            upserted += 1

        print(f"  Copied    {col_name:<25} {upserted:>5} documents")

    local_client.close()
    atlas_client.close()
    print("\nBackup complete.")


def verify():
    """Quick check: compare document counts between local and Atlas."""
    if not ATLAS_URL:
        print("ATLAS_URL not set.")
        return

    local_client = MongoClient(LOCAL_URL)
    atlas_client = MongoClient(ATLAS_URL)
    local_db     = local_client[DB_NAME]
    atlas_db     = atlas_client[DB_NAME]

    print(f"\n{'Collection':<25} {'Local':>8} {'Atlas':>8}")
    print("-" * 45)
    for col_name in local_db.list_collection_names():
        local_count = local_db[col_name].count_documents({})
        atlas_count = atlas_db[col_name].count_documents({})
        match = "✓" if local_count == atlas_count else "✗ MISMATCH"
        print(f"  {col_name:<23} {local_count:>8} {atlas_count:>8}  {match}")

    local_client.close()
    atlas_client.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "verify":
        verify()
    else:
        backup()
        verify()
