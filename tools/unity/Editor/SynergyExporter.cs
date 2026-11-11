#if UNITY_EDITOR
// Synergy Engine exporter for Unity.
//
// Copy this file into your Unity project under any folder named "Editor"
// (for example Assets/Editor/SynergyExporter.cs). It adds two menu items:
//
//   Tools > Synergy > Export Tilemaps In Open Scenes...
//       Writes, into a folder you choose:
//         tiles.json          every Tile asset the tilemaps use: id (the asset's name),
//                             sprite, colour, and the serialized fields of your custom
//                             Tile class under "data" (climate, elevation, ...)
//         map-<Grid>.json     one per Grid: the grid's shape and each Tilemap's cells
//         <texture>.png       the sprite sheets the tiles use, copied as they are
//       Load them with TilePalette.load(...) and createTilemaps(...).
//
//   Tools > Synergy > Export Selected Assets As Data...
//       Writes one <TypeName>.json per ScriptableObject type in the selection: a list of
//       records, each with "id" (the asset's name) and the asset's serialized fields.
//       Load them into a Catalog.
//
// See tools/unity/README.md in the Synergy repository for the formats and what is left out.
// Written for Unity 2019.4 or newer, using only UnityEditor and UnityEngine.Tilemaps APIs.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Tilemaps;

public static class SynergyExporter
{
    // ---- Menu items -------------------------------------------------------------------

    [MenuItem("Tools/Synergy/Export Tilemaps In Open Scenes...")]
    public static void ExportTilemaps()
    {
        string folder = EditorUtility.SaveFolderPanel("Export tilemaps to", "", "");
        if (string.IsNullOrEmpty(folder)) return;

        var session = new Session(folder);
        int maps = 0;
        foreach (Grid grid in Resources.FindObjectsOfTypeAll<Grid>())
        {
            // Only what is in an open scene: not prefab assets, and not the grid the Tile
            // Palette window keeps for the palette itself.
            if (!grid.gameObject.scene.IsValid()) continue;
            if (EditorSceneManager.IsPreviewSceneObject(grid)) continue;
            if ((grid.gameObject.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
            Json map = session.ExportGrid(grid);
            if (map == null) continue;
            File.WriteAllText(Path.Combine(folder, "map-" + SafeFileName(grid.name) + ".json"), Write(map));
            maps++;
        }
        File.WriteAllText(Path.Combine(folder, "tiles.json"), Write(session.Palette()));
        Debug.Log("Synergy: exported " + maps + " map(s), " + session.TileCount + " tile(s) and " + session.SheetCount +
                  " sprite sheet(s) to " + folder + session.WarningSummary());
    }

    [MenuItem("Tools/Synergy/Export Selected Assets As Data...")]
    public static void ExportSelectedAssets()
    {
        string folder = EditorUtility.SaveFolderPanel("Export data to", "", "");
        if (string.IsNullOrEmpty(folder)) return;

        var session = new Session(folder);
        var byType = new Dictionary<string, List<object>>();
        foreach (UnityEngine.Object selected in Selection.GetFiltered<ScriptableObject>(SelectionMode.Assets))
        {
            string type = selected.GetType().Name;
            List<object> records;
            if (!byType.TryGetValue(type, out records))
            {
                records = new List<object>();
                byType[type] = records;
            }
            var record = new Json();
            Json fields = session.Fields(selected, null);
            // "id" is the asset's name, unless the asset has a field called "id" of its own.
            if (!fields.Has("id")) record.Add("id", selected.name);
            else record.Add("name", selected.name);
            foreach (KeyValuePair<string, object> field in fields) record.Add(field.Key, field.Value);
            records.Add(record);
        }
        foreach (KeyValuePair<string, List<object>> entry in byType)
        {
            File.WriteAllText(Path.Combine(folder, SafeFileName(entry.Key) + ".json"), Write(entry.Value));
        }
        Debug.Log("Synergy: exported " + byType.Count + " type(s) of asset to " + folder + session.WarningSummary());
    }

    [MenuItem("Tools/Synergy/Export Selected Assets As Data...", true)]
    private static bool CanExportSelectedAssets()
    {
        return Selection.GetFiltered<ScriptableObject>(SelectionMode.Assets).Length > 0;
    }

    // ---- One export run ---------------------------------------------------------------

    private sealed class Session
    {
        private readonly string folder;
        private readonly Dictionary<TileBase, string> tileIds = new Dictionary<TileBase, string>();
        private readonly HashSet<string> usedTileIds = new HashSet<string>();
        private readonly List<object> tiles = new List<object>();
        private readonly Dictionary<Texture2D, Sheet> sheets = new Dictionary<Texture2D, Sheet>();
        private readonly HashSet<string> usedSheetNames = new HashSet<string>();
        private readonly List<string> warnings = new List<string>();

        public Session(string folder)
        {
            this.folder = folder;
        }

        public int TileCount { get { return tiles.Count; } }
        public int SheetCount { get { return sheets.Count; } }

        public string WarningSummary()
        {
            if (warnings.Count == 0) return ".";
            foreach (string warning in warnings) Debug.LogWarning("Synergy: " + warning);
            return ", with " + warnings.Count + " warning(s): see the Console.";
        }

        /// <summary>The map file for one Grid, or null when it has no painted Tilemap.</summary>
        public Json ExportGrid(Grid grid)
        {
            string layout = grid.cellLayout.ToString().ToLowerInvariant();
            if (layout != "rectangle" && layout != "hexagon")
            {
                warnings.Add("Grid \"" + grid.name + "\" uses the " + grid.cellLayout + " layout, which Synergy does not have. It was skipped.");
                return null;
            }

            var layers = new List<object>();
            foreach (Tilemap tilemap in grid.GetComponentsInChildren<Tilemap>(true))
            {
                ExportTilemap(tilemap, layers);
            }
            if (layers.Count == 0) return null;

            var shape = new Json();
            shape.Add("cellLayout", layout);
            shape.Add("cellSwizzle", grid.cellSwizzle.ToString().ToLowerInvariant());
            shape.Add("cellSize", Numbers(grid.cellSize.x, grid.cellSize.y, grid.cellSize.z));
            if (grid.cellGap != Vector3.zero) shape.Add("cellGap", Numbers(grid.cellGap.x, grid.cellGap.y, grid.cellGap.z));

            var map = new Json();
            map.Add("grid", shape);
            map.Add("layers", layers);
            return map;
        }

        private void ExportTilemap(Tilemap tilemap, List<object> layers)
        {
            // Group the painted cells by z: a layer of data holds one z.
            var byZ = new SortedDictionary<int, List<Vector3Int>>();
            foreach (Vector3Int position in tilemap.cellBounds.allPositionsWithin)
            {
                if (!tilemap.HasTile(position)) continue;
                List<Vector3Int> cells;
                if (!byZ.TryGetValue(position.z, out cells))
                {
                    cells = new List<Vector3Int>();
                    byZ[position.z] = cells;
                }
                cells.Add(position);
            }

            TilemapRenderer renderer = tilemap.GetComponent<TilemapRenderer>();
            foreach (KeyValuePair<int, List<Vector3Int>> level in byZ)
            {
                int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
                foreach (Vector3Int cell in level.Value)
                {
                    minX = Math.Min(minX, cell.x);
                    minY = Math.Min(minY, cell.y);
                    maxX = Math.Max(maxX, cell.x);
                    maxY = Math.Max(maxY, cell.y);
                }
                int width = maxX - minX + 1;
                int height = maxY - minY + 1;
                var indexes = new int[width * height];
                for (int i = 0; i < indexes.Length; i++) indexes[i] = -1;

                var layerTiles = new List<object>();
                var layerIndex = new Dictionary<string, int>();
                foreach (Vector3Int cell in level.Value)
                {
                    string id = TileId(tilemap.GetTile(cell), tilemap, cell);
                    int index;
                    if (!layerIndex.TryGetValue(id, out index))
                    {
                        index = layerTiles.Count;
                        layerTiles.Add(id);
                        layerIndex[id] = index;
                    }
                    indexes[(cell.y - minY) * width + (cell.x - minX)] = index;
                }

                var layer = new Json();
                layer.Add("name", byZ.Count > 1 ? tilemap.name + "@" + level.Key : tilemap.name);
                if (renderer != null && renderer.sortingOrder != 0) layer.Add("sortingOrder", renderer.sortingOrder);
                if (level.Key != 0) layer.Add("z", level.Key);
                if (tilemap.color != Color.white) layer.Add("color", Hex(tilemap.color));
                layer.Add("tiles", layerTiles);
                layer.Add("origin", Numbers(minX, minY));
                layer.Add("width", width);
                layer.Add("height", height);
                layer.Add("cells", new Rows(indexes, width));
                layers.Add(layer);
            }
        }

        /// <summary>The id of a tile asset, adding its definition to the palette the first time it is seen.</summary>
        private string TileId(TileBase tile, Tilemap tilemap, Vector3Int cell)
        {
            string id;
            if (tileIds.TryGetValue(tile, out id)) return id;

            id = Unique(string.IsNullOrEmpty(tile.name) ? "tile" : tile.name, usedTileIds);
            if (id != tile.name) warnings.Add("Two tile assets are named \"" + tile.name + "\"; one was exported as \"" + id + "\".");
            tileIds[tile] = id;

            var definition = new Json();
            definition.Add("id", id);
            Tile plain = tile as Tile;
            // A rule tile or other scripted tile has no single sprite: take the one it shows in this cell.
            Sprite sprite = plain != null ? plain.sprite : tilemap.GetSprite(cell);
            Color color = plain != null ? plain.color : Color.white;
            if (plain == null)
            {
                warnings.Add("Tile \"" + id + "\" is a " + tile.GetType().Name + ", not a plain Tile. It was exported with the one sprite it shows at " +
                             cell + "; port its rules by overriding getTileData.");
            }
            if (sprite != null) definition.Add("sprite", SpritePath(sprite));
            if (color != Color.white) definition.Add("color", Hex(color));
            Json data = Fields(tile, BuiltInTileFields);
            if (data.Count > 0) definition.Add("data", data);
            tiles.Add(definition);
            return id;
        }

        public Json Palette()
        {
            var sheetData = new Json();
            foreach (Sheet sheet in sheets.Values) sheetData.Add(sheet.Name, sheet.Data);
            var palette = new Json();
            if (sheets.Count > 0) palette.Add("sheets", sheetData);
            palette.Add("tiles", tiles);
            return palette;
        }

        /// <summary>"sheet/sprite" for a sprite, registering its sheet and copying the image the first time.</summary>
        private string SpritePath(Sprite sprite)
        {
            Texture2D texture = sprite.texture;
            Sheet sheet;
            if (!sheets.TryGetValue(texture, out sheet))
            {
                sheet = new Sheet();
                sheet.Name = Unique(SafeFileName(texture.name), usedSheetNames);
                sheet.Scale = 1f;

                string assetPath = AssetDatabase.GetAssetPath(texture);
                string image = sheet.Name + ".png";
                if (!string.IsNullOrEmpty(assetPath) && File.Exists(assetPath))
                {
                    image = sheet.Name + Path.GetExtension(assetPath).ToLowerInvariant();
                    File.Copy(assetPath, Path.Combine(folder, image), true);
#if UNITY_2021_2_OR_NEWER
                    // The copied file is the source image. If Unity imported it smaller
                    // (Max Size), sprite rectangles are in imported pixels: scale them back.
                    TextureImporter importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
                    if (importer != null)
                    {
                        int sourceWidth, sourceHeight;
                        importer.GetSourceTextureWidthAndHeight(out sourceWidth, out sourceHeight);
                        if (texture.width > 0 && sourceWidth > 0) sheet.Scale = (float)sourceWidth / texture.width;
                    }
#endif
                }
                else
                {
                    warnings.Add("The image for texture \"" + texture.name + "\" could not be found on disk; add \"" + image + "\" to the export folder yourself.");
                }

                sheet.Height = texture.height * sheet.Scale;
                sheet.Data = new Json();
                sheet.Data.Add("image", image);
                sheet.Data.Add("pixelsPerUnit", Round(sprite.pixelsPerUnit * sheet.Scale));
                sheet.Sprites = new Json();
                sheet.Data.Add("sprites", sheet.Sprites);
                sheets[texture] = sheet;
            }

            string name = string.IsNullOrEmpty(sprite.name) ? "sprite" : sprite.name;
            if (!sheet.Sprites.Has(name))
            {
                Rect rect = sprite.rect;
                var data = new Json();
                data.Add("x", Round(rect.x * sheet.Scale));
                // Unity measures from the bottom of the image, Synergy from the top.
                data.Add("y", Round(sheet.Height - (rect.y + rect.height) * sheet.Scale));
                data.Add("width", Round(rect.width * sheet.Scale));
                data.Add("height", Round(rect.height * sheet.Scale));
                float pivotX = rect.width > 0 ? sprite.pivot.x / rect.width : 0.5f;
                float pivotY = rect.height > 0 ? sprite.pivot.y / rect.height : 0.5f;
                if (Mathf.Abs(pivotX - 0.5f) > 0.0001f || Mathf.Abs(pivotY - 0.5f) > 0.0001f) data.Add("pivot", Numbers(pivotX, pivotY));
                sheet.Sprites.Add(name, data);
            }
            return sheet.Name + "/" + name;
        }

        /// <summary>The serialized fields of an asset as JSON, leaving out the names in `skip`.</summary>
        public Json Fields(UnityEngine.Object asset, HashSet<string> skip)
        {
            var fields = new Json();
            var serialized = new SerializedObject(asset);
            SerializedProperty property = serialized.GetIterator();
            bool enterChildren = true;
            while (property.NextVisible(enterChildren))
            {
                enterChildren = false;
                if (property.name == "m_Script") continue;
                if (skip != null && skip.Contains(property.name)) continue;
                fields.Add(property.name, Value(property));
            }
            return fields;
        }

        private object Value(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return property.longValue;
                case SerializedPropertyType.LayerMask:
                case SerializedPropertyType.ArraySize:
                case SerializedPropertyType.Character:
                    return property.intValue;
                case SerializedPropertyType.Boolean:
                    return property.boolValue;
                case SerializedPropertyType.Float:
                    return Round(property.floatValue);
                case SerializedPropertyType.String:
                    return property.stringValue;
                case SerializedPropertyType.Enum:
                    // The name as written in C#, so it reads the same as a TypeScript string union.
                    int index = property.enumValueIndex;
                    if (index >= 0 && index < property.enumNames.Length) return property.enumNames[index];
                    return property.intValue;
                case SerializedPropertyType.Color:
                    return Hex(property.colorValue);
                case SerializedPropertyType.Vector2:
                    return Numbers(property.vector2Value.x, property.vector2Value.y);
                case SerializedPropertyType.Vector3:
                    return Numbers(property.vector3Value.x, property.vector3Value.y, property.vector3Value.z);
                case SerializedPropertyType.Vector4:
                    return Numbers(property.vector4Value.x, property.vector4Value.y, property.vector4Value.z, property.vector4Value.w);
                case SerializedPropertyType.Quaternion:
                    return Numbers(property.quaternionValue.x, property.quaternionValue.y, property.quaternionValue.z, property.quaternionValue.w);
                case SerializedPropertyType.Vector2Int:
                    return Numbers(property.vector2IntValue.x, property.vector2IntValue.y);
                case SerializedPropertyType.Vector3Int:
                    return Numbers(property.vector3IntValue.x, property.vector3IntValue.y, property.vector3IntValue.z);
                case SerializedPropertyType.Rect:
                    return Numbers(property.rectValue.x, property.rectValue.y, property.rectValue.width, property.rectValue.height);
                case SerializedPropertyType.ObjectReference:
                    return Reference(property.objectReferenceValue);
                case SerializedPropertyType.Generic:
                    return property.isArray ? (object)Items(property) : Nested(property);
                default:
                    // Curves, gradients, bounds and the like have no plain-data form here.
                    warnings.Add("The field \"" + property.propertyPath + "\" (" + property.propertyType + ") was exported as null.");
                    return null;
            }
        }

        private List<object> Items(SerializedProperty property)
        {
            var items = new List<object>();
            for (int i = 0; i < property.arraySize; i++) items.Add(Value(property.GetArrayElementAtIndex(i)));
            return items;
        }

        private Json Nested(SerializedProperty property)
        {
            var fields = new Json();
            SerializedProperty child = property.Copy();
            SerializedProperty end = property.GetEndProperty();
            bool enterChildren = true;
            while (child.NextVisible(enterChildren) && !SerializedProperty.EqualContents(child, end))
            {
                enterChildren = false;
                fields.Add(child.name, Value(child));
            }
            return fields;
        }

        /// <summary>Another asset is referred to by name: the id it gets when it is exported too.</summary>
        private object Reference(UnityEngine.Object target)
        {
            if (target == null) return null;
            Sprite sprite = target as Sprite;
            if (sprite != null) return SpritePath(sprite);
            return target.name;
        }
    }

    private sealed class Sheet
    {
        public string Name;
        public float Scale;
        public float Height;
        public Json Data;
        public Json Sprites;
    }

    /// <summary>The fields every Tile has, which the palette already covers.</summary>
    private static readonly HashSet<string> BuiltInTileFields = new HashSet<string>
    {
        "m_Sprite", "m_Color", "m_Transform", "m_InstancedGameObject", "m_Flags", "m_ColliderType",
    };

    // ---- A very small JSON writer -------------------------------------------------------
    // Unity's JsonUtility cannot write dictionaries or mixed lists, so this does it by hand.

    /// <summary>A JSON object that keeps its keys in the order they were added.</summary>
    private sealed class Json : List<KeyValuePair<string, object>>
    {
        public void Add(string key, object value)
        {
            Add(new KeyValuePair<string, object>(key, value));
        }

        public bool Has(string key)
        {
            foreach (KeyValuePair<string, object> entry in this) if (entry.Key == key) return true;
            return false;
        }
    }

    /// <summary>A list of numbers written on one line.</summary>
    private sealed class Inline
    {
        public readonly double[] Values;

        public Inline(double[] values)
        {
            Values = values;
        }
    }

    /// <summary>A map layer's cells, written one row of the map per line.</summary>
    private sealed class Rows
    {
        public readonly int[] Values;
        public readonly int Width;

        public Rows(int[] values, int width)
        {
            Values = values;
            Width = width;
        }
    }

    private static Inline Numbers(params double[] values)
    {
        return new Inline(values);
    }

    private static double Round(double value)
    {
        return Math.Round(value, 4);
    }

    private static string Hex(Color color)
    {
        Color32 c = color;
        string rgb = "#" + c.r.ToString("x2") + c.g.ToString("x2") + c.b.ToString("x2");
        return c.a == 255 ? rgb : rgb + c.a.ToString("x2");
    }

    private static string Unique(string wanted, HashSet<string> used)
    {
        string name = wanted;
        for (int n = 2; used.Contains(name); n++) name = wanted + "_" + n;
        used.Add(name);
        return name;
    }

    private static string SafeFileName(string name)
    {
        var builder = new StringBuilder();
        foreach (char c in name) builder.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
        return builder.Length == 0 ? "unnamed" : builder.ToString();
    }

    private static string Write(object value)
    {
        var builder = new StringBuilder();
        Write(builder, value, 0);
        builder.Append('\n');
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, object value, int depth)
    {
        string indent = new string(' ', depth * 2);
        string inner = new string(' ', (depth + 1) * 2);

        if (value == null) builder.Append("null");
        else if (value is string) WriteString(builder, (string)value);
        else if (value is bool) builder.Append((bool)value ? "true" : "false");
        else if (value is Inline)
        {
            builder.Append('[');
            double[] numbers = ((Inline)value).Values;
            for (int i = 0; i < numbers.Length; i++)
            {
                if (i > 0) builder.Append(", ");
                builder.Append(Round(numbers[i]).ToString("R", CultureInfo.InvariantCulture));
            }
            builder.Append(']');
        }
        else if (value is Rows)
        {
            Rows rows = (Rows)value;
            builder.Append('[');
            for (int i = 0; i < rows.Values.Length; i++)
            {
                if (i % rows.Width == 0) builder.Append('\n').Append(inner);
                builder.Append(rows.Values[i].ToString(CultureInfo.InvariantCulture));
                if (i < rows.Values.Length - 1) builder.Append(i % rows.Width == rows.Width - 1 ? "," : ", ");
            }
            builder.Append('\n').Append(indent).Append(']');
        }
        else if (value is Json)
        {
            Json json = (Json)value;
            if (json.Count == 0)
            {
                builder.Append("{}");
                return;
            }
            builder.Append("{\n");
            for (int i = 0; i < json.Count; i++)
            {
                builder.Append(inner);
                WriteString(builder, json[i].Key);
                builder.Append(": ");
                Write(builder, json[i].Value, depth + 1);
                builder.Append(i < json.Count - 1 ? ",\n" : "\n");
            }
            builder.Append(indent).Append('}');
        }
        else if (value is IList)
        {
            IList list = (IList)value;
            if (list.Count == 0)
            {
                builder.Append("[]");
                return;
            }
            builder.Append("[\n");
            for (int i = 0; i < list.Count; i++)
            {
                builder.Append(inner);
                Write(builder, list[i], depth + 1);
                builder.Append(i < list.Count - 1 ? ",\n" : "\n");
            }
            builder.Append(indent).Append(']');
        }
        else if (value is float || value is double || value is decimal)
        {
            builder.Append(Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture));
        }
        else
        {
            // Whole numbers of any width.
            builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
        }
    }

    private static void WriteString(StringBuilder builder, string text)
    {
        builder.Append('"');
        foreach (char c in text)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
                    else builder.Append(c);
                    break;
            }
        }
        builder.Append('"');
    }
}
#endif
