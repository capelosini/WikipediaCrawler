from pymongo import MongoClient, errors

MONGO_WIKIS_TABLE = "wikis"

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

    def insertManyWikis(self, wikis):
        try:
            return len(self.db[MONGO_WIKIS_TABLE].insert_many(wikis, ordered=False).inserted_ids)
        except errors.BulkWriteError as bwe:
            return bwe.details.get("nInserted", 0)
