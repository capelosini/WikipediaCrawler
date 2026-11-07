import struct
from neo4j import GraphDatabase

URI = "bolt://localhost:7687"
AUTH = ("neo4j", "testpass")

def exportGraphToBinary():
    driver = GraphDatabase.driver(URI, auth=AUTH)

    # 1. Fetch all nodes with real titles, properties, and computed GDS metrics
    queryNodes = """
    MATCH (p:Page)
    RETURN
        id(p) AS nodeId,
        coalesce(p.title, "Untitled") AS title,
        coalesce(p.inDegree, 0) + coalesce(p.outDegree, 0) AS degree,
        coalesce(p.community, 0) AS communityId,
        coalesce(p.x, rand() * 1000) AS x,
        coalesce(p.y, rand() * 1000) AS y
    """

    # 2. Fetch all relationship links
    queryEdges = """
    MATCH (s:Page)-[:LINKS]->(t:Page)
    RETURN id(s) AS source, id(t) AS target
    """

    print("Fetching nodes and properties from Neo4j...")
    records, _, _ = driver.execute_query(queryNodes)

    stringOffset = 0
    with open("nodes.bin", "wb") as fNodes, open("strings.bin", "wb") as fStrings:
        for record in records:
            nodeId = record["nodeId"]
            title = record["title"]
            degree = record["degree"]
            communityId = record["communityId"]
            x = float(record["x"])
            y = float(record["y"])

            encodedTitle = title.encode("utf-8")
            titleLength = len(encodedTitle)

            # Pack node struct (26 bytes):
            # <I (4B id) f (4B x) f (4B y) I (4B degree) I (4B community) I (4B offset) H (2B length)
            fNodes.write(struct.pack("<I f f I I I H",
                nodeId, x, y, degree, communityId, stringOffset, titleLength
            ))

            fStrings.write(encodedTitle)
            stringOffset += titleLength

    print("Streaming relationships from Neo4j directly to edges.bin...")

    with driver.session(database="neo4j") as session:
        result = session.run(queryEdges)

        with open("edges.bin", "wb") as fEdges:
            edgeCount = 0
            for record in result:
                fEdges.write(struct.pack("<I I", record["source"], record["target"]))
                edgeCount += 1

                if edgeCount % 500000 == 0:
                    print(f"Written {edgeCount:,} edges...")

            print(f"Finished writing {edgeCount:,} edges to edges.bin!")

    driver.close()
    print("Export complete! Generated nodes.bin, edges.bin, and strings.bin with real Wikipedia titles.")

if __name__ == "__main__":
    exportGraphToBinary()
