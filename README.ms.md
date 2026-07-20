# faham

[English](README.md) · **Bahasa Malaysia** · [中文](README.zh.md)

Garis masa dasar awam Malaysia.

## Status

Peringkat rangka. Belum ada data dikumpulkan — `data/events.json` masih tatasusunan kosong.

## Apa yang ingin dibina

- Merangkak sumber berita Malaysia yang boleh diakses secara terbuka setiap hari untuk menjana entri calon
- Pengguna boleh menghantar tambahan dan pembetulan
- Setiap dakwaan mesti disertakan sumber; peristiwa yang dipertikaikan mesti memaparkan kedua-dua pihak — dikuatkuasakan oleh kekangan pangkalan data, bukan sekadar niat baik
- Kaedah pemasukan dan semakan yang lebih adil masih dalam kajian

## Struktur

```
index.html          Bahagian hadapan (satu fail, tanpa rangka kerja, tanpa binaan)
data/events.json    Data peristiwa (dieksport dari pangkalan data, atau diselenggara secara manual)
db/schema.sql       Skema pangkalan data · PostgreSQL
docs/erd.md         Rajah hubungan entiti
docs/governance.md  Kriteria pemasukan dan proses semakan
```

Pratonton setempat memerlukan pelayan HTTP (membuka fail secara terus tidak akan memuatkan JSON):

```bash
python3 -m http.server 8000
```

## Lesen

- **Kod**: AGPL-3.0 — bebas digunakan dan diubah suai; jika dijalankan sebagai perkhidmatan rangkaian, kod sumber anda juga mesti diterbitkan
- **Kandungan dan data**: CC BY-SA 4.0 — pengiktirafan diperlukan, karya terbitan mengekalkan lesen yang sama

Sumber asal yang dipetik dalam setiap peristiwa kekal hak milik pemegang hak masing-masing; repositori ini hanya mengindeks dan memaut kepadanya.

## Nota

Projek ini kini tidak menjana pendapatan. Sekiranya kos pelayan dan penyelenggaraan perlu ditampung kelak, suatu bentuk pendapatan mungkin diperkenalkan; perkara itu akan dinyatakan di sini apabila berlaku.
