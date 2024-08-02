/// <reference path="../pb_data/types.d.ts" />
migrate((db) => {
  const collection = new Collection({
    "id": "mo3sx4v5nr9n9au",
    "created": "2024-08-02 19:13:33.154Z",
    "updated": "2024-08-02 19:13:33.154Z",
    "name": "hyperjumps",
    "type": "base",
    "system": false,
    "schema": [
      {
        "system": false,
        "id": "ffswnhw7",
        "name": "blockHeight",
        "type": "number",
        "required": false,
        "presentable": false,
        "unique": false,
        "options": {
          "min": null,
          "max": null,
          "noDecimal": false
        }
      },
      {
        "system": false,
        "id": "rfuzsg5g",
        "name": "blockHash",
        "type": "text",
        "required": false,
        "presentable": false,
        "unique": false,
        "options": {
          "min": null,
          "max": null,
          "pattern": ""
        }
      },
      {
        "system": false,
        "id": "2gziowvk",
        "name": "prevBlockHash",
        "type": "text",
        "required": false,
        "presentable": false,
        "unique": false,
        "options": {
          "min": null,
          "max": null,
          "pattern": ""
        }
      },
      {
        "system": false,
        "id": "xrevzpap",
        "name": "nextBlockHash",
        "type": "text",
        "required": false,
        "presentable": false,
        "unique": false,
        "options": {
          "min": null,
          "max": null,
          "pattern": ""
        }
      },
      {
        "system": false,
        "id": "p2yub6l8",
        "name": "merkleRoot",
        "type": "text",
        "required": false,
        "presentable": false,
        "unique": false,
        "options": {
          "min": null,
          "max": null,
          "pattern": ""
        }
      }
    ],
    "indexes": [
      "CREATE INDEX `idx_c3MHLIk` ON `hyperjumps` (`blockHeight`)"
    ],
    "listRule": null,
    "viewRule": null,
    "createRule": null,
    "updateRule": null,
    "deleteRule": null,
    "options": {}
  });

  return Dao(db).saveCollection(collection);
}, (db) => {
  const dao = new Dao(db);
  const collection = dao.findCollectionByNameOrId("mo3sx4v5nr9n9au");

  return dao.deleteCollection(collection);
})
