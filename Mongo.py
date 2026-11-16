from pymongo import MongoClient, errors
from bson import ObjectId

MONGO_WIKIS_TABLE = "wikis"
MONGO_WORKS_TABLE = "works"

class MongoDB:
    def __init__(self, db: str, host="localhost", port=27017):
        self.client = MongoClient(f"mongodb://crawler:testpass@{host}:{str(port)}/")
        self.db = self.client[db]
        self._setup()

    def _setup(self):
        self.db[MONGO_WIKIS_TABLE].create_index(
            [("pagelanguage", 1), ("pageid", 1)],
            unique=True
        )
        self.db[MONGO_WORKS_TABLE].create_index(
            [("id", 1)],
            unique=True
        )

    def insertManyWikis(self, wikis):
        try:
            return len(self.db[MONGO_WIKIS_TABLE].insert_many(wikis, ordered=False).inserted_ids)
        except errors.BulkWriteError as bwe:
            return bwe.details.get("nInserted", 0)

    def getWikisCount(self):
        return self.db[MONGO_WIKIS_TABLE].estimated_document_count()

    def getWikiBatches(self, batch_size=500, checkpoint_id=None):
        collection = self.db[MONGO_WIKIS_TABLE]

        query = {"_id": {"$gt": ObjectId(checkpoint_id)}} if checkpoint_id else {}

        cursor = collection.find(
            query or {},
            projection={"_id": 1, "title": 1, "linkedPages": 1},
            no_cursor_timeout=True
        ).sort("_id", 1)


        batch = []
        try:
            for doc in cursor:
                title = doc.get("title")
                links = [(l[:1].upper() + l[1:]) for l in (doc.get("linkedPages") or [])]

                # Skip invalid or linkless entries
                if not title: # or not links:
                    continue

                batch.append({
                    "_id": str(doc.get("_id")),
                    "title": title,
                    "links": links,
                    "out_degree": len(links)
                })

                if len(batch) >= batch_size:
                    yield batch
                    batch = []

            if batch:
                yield batch

        finally:
            cursor.close()

    def insertManyWorks(self, works):
        try:
            return len(self.db[MONGO_WORKS_TABLE].insert_many(works, ordered=False).inserted_ids)
        except errors.BulkWriteError as bwe:
            return bwe.details.get("nInserted", 0)

    def getWorksCount(self):
        return self.db[MONGO_WORKS_TABLE].estimated_document_count()

    def getWorkBatches(self, batch_size=500, checkpoint_id=None):
        collection = self.db[MONGO_WORKS_TABLE]

        query = {"_id": {"$gt": ObjectId(checkpoint_id)}} if checkpoint_id else {}

        cursor = collection.find(
            query or {},
            projection={"_id": 1, "id": 1, "title": 1, "publication_year": 1, "referenced_works": 1},
            no_cursor_timeout=True
        ).sort("_id", 1)

        batch = []
        try:
            for doc in cursor:
                articleId = doc.get("id")
                refs = doc.get("referenced_works") or []

                if not articleId:
                    continue

                batch.append({
                    "_id": str(doc.get("_id")),
                    "id": articleId,
                    "title": doc.get("title"),
                    "year": doc.get("publication_year"),
                    "refs": refs,
                    "out_degree": len(refs)
                })

                if len(batch) >= batch_size:
                    yield batch
                    batch = []

            if batch:
                yield batch

        finally:
            cursor.close()

    # just for fun
    def searchWiki(self, title: str):
        return self.db[MONGO_WIKIS_TABLE].find_one({"title": title})