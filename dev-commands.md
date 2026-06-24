```
curl http://localhost/webhook \
  -H 'Authorization: Bearer {token}' \
  -H 'Content-Type: application/json' \
  -d '{"compound":"Choline","accession":"MSBNK-Metabolon-MT000030","algorithm":"linear","parameters":{"offset":300},"frequencies":[356.2,357.1,358.2,359.2,360.2,361.2,370.1,371.1,372,373.2,374.1,375.2,376.2,385.2,386.2,389.1,403.1,404.1,405.2],"amplitudes":[0.001,0.002,0.013,0.005,0.345,0.01,0.003,0.002,0.005,0.004,0.004,0.004,0.002,0.006,0.005,0.002,0.005,1,0.082]}'
```