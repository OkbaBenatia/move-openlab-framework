"""Connectors to public data services.

:mod:`.rpc` — French national carpooling proof registry (RPC) open-data releases on data.gouv.fr (Licence Ouverte /
Etalab), used by the dataset layer (:mod:`move_openlab.datasets`) and the ``/api/datasets/rpc`` routes. It contacts
data.gouv.fr only when a release list or an ingestion is requested.

Uploaded or third-party trip sources are dataset providers: see :mod:`move_openlab.datasets` and
``docs/DATASETS.md``. Road networks from OpenStreetMap are handled by :mod:`move_openlab.geo.osm`.
"""
