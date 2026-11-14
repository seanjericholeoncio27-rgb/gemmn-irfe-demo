// Column lists that leave out the heavy columns — signature images, pasted
// reference images and cost-builder JSON — for screens that only need to list,
// total or report on documents. Fetch the full record (select('*, …_items(*)'))
// only when a document is actually opened for viewing, editing or printing.
// Verified against the live schema of quotations / quotation_items / invoices /
// invoice_items; update here if a column is added to those tables.

export const QUOTATION_COLS = 'id,client,date,valid_until,status,notes,tax,created_at,company_name,address,attention,delivery_date,payment_terms,prepared_by,vat_mode,signatory_position,commission_referrer,commission_pct,commission_status,discount_pct,po_number,version_number,root_quotation_id,job_order_number'
export const QUOTATION_ITEM_COLS = 'id,quotation_id,description,qty,unit,price,kind,position,dimension,show_on_export,line_uid,details,image_scale'
export const QUOTATION_SELECT = `${QUOTATION_COLS}, quotation_items(${QUOTATION_ITEM_COLS})`

export const INVOICE_COLS = 'id,quotation_id,client,date,due_date,status,notes,tax,created_at,company_name,address,attention,prepared_by,vat_mode,cr_number,signatory_position,payment_terms,dr_number,delivery_date,collection_date,collection_amount,po_number'
export const INVOICE_ITEM_COLS = 'id,invoice_id,description,qty,unit,price,kind,position,dimension,show_on_export,source_line_uid,details,image_scale'
export const INVOICE_SELECT = `${INVOICE_COLS}, invoice_items(${INVOICE_ITEM_COLS})`
